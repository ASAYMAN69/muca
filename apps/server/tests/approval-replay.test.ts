import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { createApiRouter } from '../src/http/api.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { PendingApprovalRegistry } from '../src/store/pending-approvals.js';
import type { AIProvider, ProviderResponse } from '../src/ai/provider.js';

/**
 * A provider that asks for a specific branch on each run.
 *
 * A run always begins with the system message and the user message, so the
 * message count tells us where a run starts. The branch changes per run,
 * which is what lets a test check that an approval does not carry over to
 * a different action.
 */
class ScriptedBranchProvider implements AIProvider {
  readonly name = 'scripted-branch-provider';
  private turn = 0;
  private run = 0;

  constructor(private readonly branches: string[]) {}

  async chat(input: { messages: unknown[] }): Promise<ProviderResponse> {
    if (input.messages.length <= 2) {
      this.turn = 0;
      this.run += 1;
    }
    this.turn += 1;

    if (this.turn === 1) {
      const branch = this.branches[Math.min(this.run - 1, this.branches.length - 1)]!;
      return {
        content: null,
        toolCalls: [
          {
            id: `call_branch_${this.run}`,
            name: 'create_branch',
            arguments: JSON.stringify({ name: branch, baseBranch: 'main' }),
          },
        ],
        finishReason: 'tool_calls',
      };
    }
    return {
      content: 'Created the branch.',
      toolCalls: [],
      finishReason: 'stop',
    };
  }
}

interface ChatBody {
  awaitingConfirmation: boolean;
  pendingCall: { callId: string; name: string; arguments: Record<string, unknown> } | null;
  events: Array<{ type: string; name?: string; result?: { summary?: string } }>;
}

describe('an approval cannot be replayed', () => {
  let httpServer: Server;
  let baseUrl: string;
  let pendingApprovals: PendingApprovalRegistry;

  beforeAll(async () => {
    pendingApprovals = new PendingApprovalRegistry();

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createApiRouter({
        registry: new ToolRegistry().registerAll(createTools()),
        // Run 1 asks for feature/first, run 2 for feature/second, run 3
        // for feature/first again.
        provider: new ScriptedBranchProvider([
          'feature/first',
          'feature/second',
          'feature/first',
        ]),
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
        pendingApprovals,
      }),
    );

    httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function chat(
    message: string,
    approvedCallIds: string[] = [],
  ): Promise<ChatBody> {
    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, history: [], approvedCallIds }),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as ChatBody;
  }

  it('retires an approval even when the run parks again on another action', async () => {
    // Run 1: the model asks for feature/first. Nothing is approved yet.
    const first = await chat('create a branch');
    expect(first.awaitingConfirmation).toBe(true);
    expect(first.pendingCall).not.toBeNull();
    expect(first.pendingCall!.arguments).toMatchObject({ name: 'feature/first' });
    const firstCallId = first.pendingCall!.callId;

    // Run 2: the user approves that action, but the model now asks for a
    // DIFFERENT branch, so the run parks again without running anything.
    const second = await chat('go ahead', [firstCallId]);
    expect(second.awaitingConfirmation).toBe(true);
    expect(second.pendingCall).not.toBeNull();
    expect(second.pendingCall!.arguments).toMatchObject({ name: 'feature/second' });
    expect(
      second.events.filter((event) => event.type === 'tool_result'),
    ).toHaveLength(0);

    // Run 3: the client replays the FIRST approval. The model asks for
    // feature/first again. The approval was already spent, so this must
    // park again — it must NOT run the tool.
    const third = await chat('go ahead', [firstCallId]);
    expect(third.awaitingConfirmation).toBe(true);
    expect(third.pendingCall).not.toBeNull();
    expect(
      third.events.filter((event) => event.type === 'tool_result'),
    ).toHaveLength(0);
  });

  it('does not let a spent approval authorise a second call', async () => {
    // Run 1 parks on feature/first.
    const first = await chat('create a branch');
    expect(first.awaitingConfirmation).toBe(true);
    const callId = first.pendingCall!.callId;

    // Run 2 approves it and the tool runs.
    const second = await chat('go ahead', [callId]);
    expect(second.awaitingConfirmation).toBe(false);
    expect(
      second.events.filter((event) => event.type === 'tool_result').length,
    ).toBeGreaterThan(0);

    // Run 3 replays the same approval. The model asks for feature/first
    // again, which is a different action from the one that ran.
    const third = await chat('again', [callId]);
    expect(
      third.events.filter((event) => event.type === 'tool_result'),
    ).toHaveLength(0);
  });
});
