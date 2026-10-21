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
import { RunHistoryStore } from '../src/store/run-history.js';
import { PendingApprovalRegistry } from '../src/store/pending-approvals.js';
import type { AIProvider, ProviderResponse } from '../src/ai/provider.js';

/**
 * A provider that asks for the destructive `create_branch` tool once per
 * run, then answers.
 *
 * The script restarts on every run: a run always begins with the system
 * message and the user message, so the message count tells us where a run
 * starts.
 */
class BranchProvider implements AIProvider {
  readonly name = 'branch-provider';
  private turn = 0;

  async chat(input: { messages: unknown[] }): Promise<ProviderResponse> {
    if (input.messages.length <= 2) {
      this.turn = 0;
    }
    this.turn += 1;

    if (this.turn === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: 'call_branch',
            name: 'create_branch',
            arguments: '{"name":"fix/checkout-rounding","baseBranch":"main"}',
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
  let runHistory: RunHistoryStore;
  let pendingApprovals: PendingApprovalRegistry;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'muca-api-'));
    runHistory = new RunHistoryStore(join(tempDir, 'runs'));
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
        runHistory,
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
  /* Runs                                                             */
  /* ---------------------------------------------------------------- */

  it('GET /runs lists the run history', async () => {
    const response = await fetch(`${baseUrl}/runs`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      runs: Array<{ id: string; outcome: string; toolCallCount: number }>;
    };
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it('POST /chat records the run and GET /runs/:runId returns it', async () => {
    const chat = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'create a branch', history: [] }),
    });
    expect(chat.status).toBe(200);

    const chatBody = (await chat.json()) as { runId: string };
    expect(chatBody.runId).toBeTruthy();

    const response = await fetch(`${baseUrl}/runs/${chatBody.runId}`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      run: {
        id: string;
        userMessage: string;
        toolCalls: Array<{ name: string }>;
        approvals: Array<{ toolName: string; decision: string }>;
        outcome: string;
      };
    };
    expect(body.run.id).toBe(chatBody.runId);
    expect(body.run.userMessage).toBe('create a branch');
    expect(body.run.toolCalls.some((t) => t.name === 'create_branch')).toBe(true);
    expect(body.run.outcome).toBe('awaiting_approval');
  });

  it('GET /runs/:runId returns 404 for an unknown run', async () => {
    const response = await fetch(`${baseUrl}/runs/run_nope`);
    expect(response.status).toBe(404);

    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('No run with id');
  });

  it('keeps the run history across a new store instance', async () => {
    // "Restart": a fresh store over the same directory.
    const restarted = new RunHistoryStore(join(tempDir, 'runs'));
    const runs = restarted.list();
    expect(runs.length).toBeGreaterThan(0);
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
    const history = new RunHistoryStore(join(tempDir, 'runs-approval'));
    app.use(
      '/api/v1',
      createApiRouter({
        registry: new ToolRegistry().registerAll(createTools()),
        provider: new BranchProvider(),
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
        runHistory: history,
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
});
