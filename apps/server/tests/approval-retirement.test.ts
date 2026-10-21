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
 * The lifecycle of a spent approval.
 *
 * The registry is the authority on which call ids the server issued, so a
 * stale entry in it is a **standing authorisation**. An approval must
 * therefore be retired the moment it has been used — whatever the run
 * does afterwards.
 */

/**
 * A provider that asks for a specific branch on each run.
 *
 * A run always begins with the system message and the user message, so
 * the message count tells us where a run starts.
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
      const branch = this.branches[
        Math.min(this.run - 1, this.branches.length - 1)
      ]!;
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
  pendingCall: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
  } | null;
  events: Array<{
    type: string;
    name?: string;
    result?: { summary?: string };
  }>;
}

/** Builds a server whose provider asks for the given branches in order. */
function buildServer(
  registry: PendingApprovalRegistry,
  branches: string[],
): { server: Server; url: string } {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createApiRouter({
      registry: new ToolRegistry().registerAll(createTools()),
      provider: new ScriptedBranchProvider(branches),
      systemPrompt: 'test',
      protocolVersion: '2025-11-25',
      mcpUrl: 'http://localhost:8099/api/v1/mcp',
      pendingApprovals: registry,
    }),
  );

  const server = createServer(app);
  return { server, url: '' };
}
describe('a spent approval is retired from the registry', () => {
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

  it('no longer holds the spent id after the run parks on another action', async () => {
    // Run 1 parks on feature/first.
    const first = await chat('create a branch');
    expect(first.awaitingConfirmation).toBe(true);
    const firstCallId = first.pendingCall!.callId;

    // The registry holds it: it is a live, approvable action.
    expect(pendingApprovals.get(firstCallId)).toBeDefined();

    // Run 2 approves it, but the model asks for a different branch, so
    // the run parks again.
    const second = await chat('go ahead', [firstCallId]);
    expect(second.awaitingConfirmation).toBe(true);

    // The spent approval is gone: the registry no longer resolves it.
    expect(pendingApprovals.get(firstCallId)).toBeUndefined();

    // And the *new* parked call is registered, so the user can approve
    // that action next.
    const secondCallId = second.pendingCall!.callId;
    expect(pendingApprovals.get(secondCallId)).toBeDefined();
    expect(pendingApprovals.get(secondCallId)?.toolName).toBe('create_branch');
  });

  it('no longer holds the spent id after the run completes', async () => {
    const registry = new PendingApprovalRegistry();
    const { server, url } = buildServer(registry, ['only/branch']);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/api/v1`;

    const chat = async (message: string, approvedCallIds: string[] = []) => {
      const response = await fetch(`${base}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, history: [], approvedCallIds }),
      });
      return (await response.json()) as ChatBody;
    };

    const first = await chat('create a branch');
    const callId = first.pendingCall!.callId;
    expect(registry.get(callId)).toBeDefined();

    // Approve it; the tool runs.
    const second = await chat('go ahead', [callId]);
    expect(second.awaitingConfirmation).toBe(false);
    expect(
      second.events.filter((event) => event.type === 'tool_result').length,
    ).toBeGreaterThan(0);

    // The spent approval is retired.
    expect(registry.get(callId)).toBeUndefined();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('the same id sent twice in one request', () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createApiRouter({
        registry: new ToolRegistry().registerAll(createTools()),
        // The same branch every run, so a duplicated approval could
        // authorise it twice.
        provider: new ScriptedBranchProvider([
          'feature/same',
          'feature/same',
        ]),
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
        pendingApprovals: new PendingApprovalRegistry(),
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

  it('authorises at most one action', async () => {
    const chat = async (message: string, approvedCallIds: string[] = []) => {
      const response = await fetch(`${baseUrl}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, history: [], approvedCallIds }),
      });
      return (await response.json()) as ChatBody;
    };

    const first = await chat('create a branch');
    const callId = first.pendingCall!.callId;

    // The client sends the SAME id twice.
    const second = await chat('go ahead', [callId, callId]);

    // Exactly one tool result: one id is one approval, and it can
    // authorise at most one action.
    const results = second.events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(1);
  });
});
