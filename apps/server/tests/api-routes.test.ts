import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

import { createApiRouter } from '../src/http/api.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { PendingApprovalRegistry } from '../src/store/pending-approvals.js';
import type { AIProvider, ProviderResponse } from '../src/ai/provider.js';

/**
 * A provider that asks for the destructive `create_branch` tool with a
 * *different* branch on each run.
 *
 * The script restarts on every run: a run always begins with the system
 * message and the user message, so the message count tells us where a run
 * starts. The branch name changes per run, which is what lets a test
 * check that an approval does not carry over to a different action.
 */
class BranchProvider implements AIProvider {
  readonly name = 'branch-provider';
  private turn = 0;
  private run = 0;

  /** The branch names this provider asks for, in order. */
  constructor(
    private readonly branches: string[] = [
      'fix/checkout-rounding',
      'fix/checkout-rounding',
    ],
  ) {}

  async chat(input: { messages: unknown[] }): Promise<ProviderResponse> {
    if (input.messages.length <= 2) {
      this.turn = 0;
      this.run += 1;
    }
    this.turn += 1;

    if (this.turn === 1) {
      const branch =
        this.branches[Math.min(this.run - 1, this.branches.length - 1)]!;
      return {
        content: null,
        toolCalls: [
          {
            id: 'call_branch',
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

describe('the new REST routes', () => {
  let httpServer: Server;
  let baseUrl: string;
  let pendingApprovals: PendingApprovalRegistry;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'muca-api-'));
    pendingApprovals = new PendingApprovalRegistry();

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createApiRouter({
        registry: new ToolRegistry().registerAll(createTools()),
        provider: new BranchProvider(),
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
        pendingApprovals,
        getTask: async (taskId) =>
          taskId === 'task_known'
            ? {
                taskId,
                status: 'working',
                createdAt: '2026-03-14T09:00:00.000Z',
                lastUpdatedAt: '2026-03-14T09:00:01.000Z',
                statusMessage: 'Correlating the CI run…',
              }
            : null,
        listTasks: async () => [
          {
            taskId: 'task_known',
            status: 'working',
            createdAt: '2026-03-14T09:00:00.000Z',
            lastUpdatedAt: '2026-03-14T09:00:01.000Z',
          },
        ],
      }),
    );

    httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  /* ---------------------------------------------------------------- */
  /* Tasks                                                            */
  /* ---------------------------------------------------------------- */

  it('GET /tasks/:taskId returns the task status', async () => {
    const response = await fetch(`${baseUrl}/tasks/task_known`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      task: { taskId: string; status: string; statusMessage: string };
    };
    expect(body.task.taskId).toBe('task_known');
    expect(body.task.status).toBe('working');
    expect(body.task.statusMessage).toBe('Correlating the CI run…');
  });

  it('GET /tasks/:taskId returns 404 for an unknown task', async () => {
    const response = await fetch(`${baseUrl}/tasks/task_nope`);
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('No task with id');
  });

  it('GET /tasks lists the known tasks', async () => {
    const response = await fetch(`${baseUrl}/tasks`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      tasks: Array<{ taskId: string; status: string }>;
    };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]?.taskId).toBe('task_known');
  });

  /* ---------------------------------------------------------------- */
  /* The approval flow over HTTP                                      */
  /* ---------------------------------------------------------------- */

  it('parks a destructive tool and approves it on the next request', async () => {
    // A fresh provider so the script starts over.
    const app = express();
    app.use(express.json());
    const approvals = new PendingApprovalRegistry();
    app.use(
      '/api/v1',
      createApiRouter({
        registry: new ToolRegistry().registerAll(createTools()),
        provider: new BranchProvider(),
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
        pendingApprovals: approvals,
      }),
    );

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/v1`;

    // First request: the tool is destructive, so the run parks.
    const first = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'create a branch', history: [] }),
    });
    const firstBody = (await first.json()) as {
      awaitingConfirmation: boolean;
      pendingCall: { callId: string; name: string } | null;
    };
    expect(firstBody.awaitingConfirmation).toBe(true);
    expect(firstBody.pendingCall?.name).toBe('create_branch');
    const callId = firstBody.pendingCall!.callId;

    // Second request: the client approves that call id.
    const second = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'yes, go ahead',
        history: [],
        approvedCallIds: [callId],
      }),
    });
    const secondBody = (await second.json()) as {
      awaitingConfirmation: boolean;
      events: Array<{ type: string; name?: string; summary?: string }>;
    };

    // The tool ran this time.
    expect(secondBody.awaitingConfirmation).toBe(false);
    const toolResult = secondBody.events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(toolResult?.summary).toContain('Created branch');

    // And the approval decision is in the audit trail.
    const decision = secondBody.events.find((e) => e.type === 'approval_decision');
    expect(decision).toBeDefined();

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * The bug this guards against: the user approved
   * `create_branch(name="feature/approved")`, and the model then asked for
   * `create_branch(name="attacker-controlled")`. That is a *different*
   * action, so it must not run — the run parks again instead.
   */
  it('does not run a different action than the one the user approved', async () => {
    const app = express();
    app.use(express.json());
    const approvals = new PendingApprovalRegistry();
    app.use(
      '/api/v1',
      createApiRouter({
        registry: new ToolRegistry().registerAll(createTools()),
        // The first run asks for one branch, the second for another.
        provider: new BranchProvider([
          'fix/checkout-rounding',
          'attacker-controlled',
        ]),
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
        pendingApprovals: approvals,
      }),
    );

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/api/v1`;

    // First request: the run parks on the branch call.
    const first = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'create a branch', history: [] }),
    });
    const firstBody = (await first.json()) as {
      awaitingConfirmation: boolean;
      pendingCall: { callId: string; arguments: Record<string, unknown> } | null;
    };
    expect(firstBody.awaitingConfirmation).toBe(true);
    const callId = firstBody.pendingCall!.callId;
    const shownArguments = firstBody.pendingCall!.arguments;
    expect(shownArguments.name).toBe('fix/checkout-rounding');

    // Second request: the user approves that call id, but the model asks
    // for a *different* branch this time.
    const second = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'yes, go ahead',
        history: [],
        approvedCallIds: [callId],
      }),
    });
    const secondBody = (await second.json()) as {
      awaitingConfirmation: boolean;
      pendingCall: { callId: string; arguments: Record<string, unknown> } | null;
      events: Array<{ type: string; summary?: string }>;
    };

    // The run parked again, showing the NEW arguments.
    expect(secondBody.awaitingConfirmation).toBe(true);
    expect(secondBody.pendingCall).not.toBeNull();
    expect(secondBody.pendingCall!.arguments.name).toBe(
      'attacker-controlled',
    );

    // No tool result at all: nothing was created.
    expect(secondBody.events.some((e) => e.type === 'tool_result')).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
