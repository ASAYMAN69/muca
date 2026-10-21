import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { McpHttpHandler } from '../src/mcp/http-handler.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { createMockOpsAdapters } from '../src/tools/ops/mock.js';
import { DIAGNOSE_TOOL_NAME, TaskRunner } from '../src/mcp/tasks.js';

/**
 * Reads and parses a JSON request body.
 * The MCP transport needs the parsed body, exactly like `express.json()`.
 */
async function readJsonBody(
  req: import('node:http').IncomingMessage,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

describe('MCP Tasks', () => {
  let httpServer: Server;
  let handler: McpHttpHandler;
  let baseUrl: string;

  beforeAll(async () => {
    const registry = new ToolRegistry().registerAll(createTools());
    handler = new McpHttpHandler(registry, createMockOpsAdapters());

    httpServer = createServer((req, res) => {
      void (async () => {
        const body = await readJsonBody(req);
        const expressReq = Object.assign(req, { body }) as never;
        await handler.handle(expressReq, res as never);
      })();
    });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterAll(async () => {
    await handler.closeAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  async function connect(): Promise<Client> {
    const client = new Client(
      { name: 'muca-task-test-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    // The client learns which tools are task-capable from `tools/list`.
    // This is what a real MCP host does before it asks for a task.
    await client.listTools();
    return client;
  }

  it('publishes the long-running tool and the tasks capability', async () => {
    const client = await connect();

    const capabilities = client.getServerCapabilities();
    expect(capabilities?.tasks).toBeDefined();
    expect(capabilities?.tasks?.requests?.tools?.call).toBeDefined();

    const { tools } = await client.listTools();
    const diagnose = tools.find((t) => t.name === DIAGNOSE_TOOL_NAME);
    expect(diagnose).toBeDefined();
    // The tool is published as a task-capable tool, so a client knows it
    // can ask for a task handle.
    expect(diagnose?.execution?.taskSupport).toBe('optional');

    await client.close();
  });

  it('returns a task handle quickly instead of blocking', async () => {
    const client = await connect();

    const started = Date.now();
    const stream = client.experimental.tasks.callToolStream({
      name: DIAGNOSE_TOOL_NAME,
      arguments: { service: 'checkout-api' },
    });

    // The first message must be the task handle, and it must arrive fast.
    const first = await stream.next();
    expect(first.value?.type).toBe('taskCreated');
    const task = (first.value as { task: { taskId: string; status: string } }).task;
    expect(task.taskId).toBeTruthy();
    expect(task.status).toBe('working');
    expect(Date.now() - started).toBeLessThan(2_000);

    await client.close();
  });

  it('progresses through the task statuses and terminates', async () => {
    const client = await connect();

    const stream = client.experimental.tasks.callToolStream({
      name: DIAGNOSE_TOOL_NAME,
      arguments: { service: 'checkout-api' },
    });

    const statuses: string[] = [];
    let finalResult: unknown;

    for await (const message of stream) {
      if (message.type === 'taskStatus') {
        statuses.push(message.task.status);
      }
      if (message.type === 'result') {
        finalResult = message.result;
      }
    }

    // The task ran to a terminal state.
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[statuses.length - 1]).toBe('completed');

    // And it produced a diagnosis.
    expect(finalResult).toBeDefined();
    const text = (
      finalResult as { content: Array<{ type: string; text?: string }> }
    ).content.find((c) => c.type === 'text');
    expect(text?.text).toContain('Likely cause');

    await client.close();
  });

  it('exposes the task through the task store so it can be polled', async () => {
    const client = await connect();

    const stream = client.experimental.tasks.callToolStream({
      name: DIAGNOSE_TOOL_NAME,
      arguments: { service: 'checkout-api' },
    });

    const first = await stream.next();
    const taskId = (first.value as { task: { taskId: string } }).task.taskId;

    // Poll it directly, the way the REST endpoint does.
    const task = await handler.taskStore.getTask(taskId);
    expect(task).not.toBeNull();
    expect(task?.taskId).toBe(taskId);
    expect(['working', 'completed']).toContain(task?.status);

    // Drain the stream so the background work finishes.
    for await (const _message of stream) {
      // discard
    }

    const finished = await handler.taskStore.getTask(taskId);
    expect(finished?.status).toBe('completed');

    await client.close();
  });

  it('lists the tasks it knows about', async () => {
    const client = await connect();

    const stream = client.experimental.tasks.callToolStream({
      name: DIAGNOSE_TOOL_NAME,
      arguments: { service: 'checkout-api' },
    });
    await stream.next();
    for await (const _message of stream) {
      // discard
    }

    const { tasks } = await handler.taskStore.listTasks();
    expect(tasks.length).toBeGreaterThan(0);

    await client.close();
  });
});

describe('TaskRunner', () => {
  it('runs the steps in order and finishes', async () => {
    const runner = new TaskRunner(1_000);
    const order: string[] = [];

    await runner.run(
      'task_1',
      [
        () => {
          order.push('a');
        },
        () => {
          order.push('b');
        },
      ],
      () => {
        order.push('done');
      },
    );

    expect(order).toEqual(['a', 'b', 'done']);
  });

  it('leaves no timer behind when it finishes', async () => {
    const runner = new TaskRunner(1_000);

    await runner.run('task_1', [() => undefined], () => undefined);

    expect(runner.activeTimerCount).toBe(0);
  });

  it('leaves no timer behind when it is cancelled', async () => {
    const runner = new TaskRunner(1_000);

    const running = runner.run(
      'task_1',
      [() => undefined, () => undefined, () => undefined],
      () => undefined,
    );

    runner.cancel('task_1');
    await running;

    expect(runner.activeTimerCount).toBe(0);
  });

  it('times out a task that runs for too long', async () => {
    // The timeout must be deterministic, not a matter of timer jitter.
    // The same case is run many times in a row and must *always* time
    // out. A test that sleeps to avoid the race would prove nothing.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const runner = new TaskRunner(30);

      await expect(
        runner.run('task_1', [() => undefined, () => undefined], () => undefined),
      ).rejects.toThrow(/timed out/);

      expect(runner.activeTimerCount).toBe(0);
    }
  });

  it('does not time out a task that finishes comfortably before the deadline', async () => {
    // The other half of the guarantee: a task that finishes in time
    // must never time out, however the timers land.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const runner = new TaskRunner(5_000);
      let done = false;

      await runner.run(
        'task_1',
        [() => undefined, () => undefined],
        () => {
          done = true;
        },
      );

      expect(done).toBe(true);
      expect(runner.activeTimerCount).toBe(0);
    }
  });

  it('cancels every running task at once', async () => {
    const runner = new TaskRunner(1_000);

    const a = runner.run('task_1', [() => undefined], () => undefined);
    const b = runner.run('task_2', [() => undefined], () => undefined);

    runner.cancelAll();
    await Promise.all([a, b]);

    expect(runner.activeTimerCount).toBe(0);
  });
});
