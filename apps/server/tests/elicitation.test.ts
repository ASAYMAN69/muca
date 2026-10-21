import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { McpHttpHandler } from '../src/mcp/http-handler.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { createMockOpsAdapters } from '../src/tools/ops/mock.js';
import {
  ElicitationApprovalGate,
  type ElicitationCapable,
} from '../src/ai/approval-gate.js';
import { createElicitationSource } from '../src/mcp/elicitation.js';

/**
 * Reads and parses a JSON request body.
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

describe('MCP Elicitation over a real client', () => {
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

  /**
   * Connects a client that declares the `elicitation` capability.
   *
   * The answer function is supplied by the test, so each case can decide
   * whether the user accepts or declines.
   */
  async function connect(
    answer: (message: string) => {
      action: 'accept' | 'decline' | 'cancel';
      content?: Record<string, unknown>;
    },
  ): Promise<{
    client: Client;
    transport: StreamableHTTPClientTransport;
    elicitations: string[];
  }> {
    const elicitations: string[] = [];

    const client = new Client(
      { name: 'muca-elicitation-test-client', version: '0.1.0' },
      { capabilities: { elicitation: { form: {} } } },
    );

    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicitations.push(request.params.message);
      return answer(request.params.message);
    });

    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    return { client, transport, elicitations };
  }

  /**
   * Waits for the client to open the server→client SSE stream.
   *
   * A server→client request (the elicitation) can only travel on the
   * standalone GET stream. The client opens it as soon as it is
   * initialised, so the test waits for it to be ready before the server
   * asks it anything.
   */
  async function waitForSseStream(
    transport: StreamableHTTPClientTransport,
  ): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const response = await fetch(baseUrl, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          'mcp-session-id': transport.sessionId!,
        },
      });
      // 409 means the client already has the standalone stream open —
      // that is the state we want.
      if (response.status === 409) {
        await response.body?.cancel();
        return;
      }
      await response.body?.cancel();
      if (response.status !== 200) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      return;
    }
    throw new Error('The client never opened the SSE stream.');
  }

  it('reaches the client that opened the session', async () => {
    const { client, transport, elicitations } = await connect(() => ({
      action: 'accept',
      content: { confirm: true },
    }));

    await waitForSseStream(transport);

    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();

    const server = handler.serverForSession(sessionId!);
    expect(server).toBeDefined();

    // Build the gate from that session's server — the same way the
    // transport does.
    const source: ElicitationCapable = createElicitationSource(server!);
    const gate = new ElicitationApprovalGate(source);

    const allowed = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch (name="fix/x")',
        arguments: { name: 'fix/x' },
      },
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(allowed).toBe(true);
    // The client actually received the elicitation request.
    expect(elicitations).toHaveLength(1);
    expect(elicitations[0]).toContain('Create branch');

    await client.close();
  });

  it('does not leak a session server into another session', async () => {
    const { client, transport } = await connect(() => ({
      action: 'accept',
      content: { confirm: true },
    }));

    // A different session id has no server.
    expect(handler.serverForSession('not-a-real-session')).toBeUndefined();
    expect(handler.serverForSession(transport.sessionId!)).toBeDefined();

    await client.close();
  });

  it('falls back to the HTTP path when the client cannot elicit', async () => {
    // A client with no `elicitation` capability.
    const client = new Client(
      { name: 'muca-no-elicitation-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);

    const server = handler.serverForSession(transport.sessionId!);
    const source = createElicitationSource(server!);
    const gate = new ElicitationApprovalGate(source);

    const allowed = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: {},
      },
      requestId: 'call_1',
      // The HTTP fallback says yes.
      fallback: async () => true,
    });

    // The client could not be asked, so the fallback decided.
    expect(allowed).toBe(true);

    await client.close();
  });

  it('does not run a destructive tool when the client declines', async () => {
    const { client, transport, elicitations } = await connect(() => ({
      action: 'decline',
    }));

    await waitForSseStream(transport);

    const result = await client.callTool({
      name: 'create_branch',
      arguments: { name: 'fix/should-not-exist', baseBranch: 'main' },
    });

    // The client was asked, and said no.
    expect(elicitations).toHaveLength(1);
    expect(elicitations[0]).toContain('Create branch');

    // The tool did not run: the result is an error.
    expect(result.isError).toBe(true);
    const text = (
      result.content as Array<{ type: string; text?: string }>
    ).find((c) => c.type === 'text');
    expect(text?.text).toContain('declined');

    await client.close();
  });

  it('runs a destructive tool when the client accepts', async () => {
    const { client, transport, elicitations } = await connect(() => ({
      action: 'accept',
      content: { confirm: true },
    }));

    await waitForSseStream(transport);

    const result = await client.callTool({
      name: 'create_branch',
      arguments: { name: 'fix/approved-branch', baseBranch: 'main' },
    });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    const text = (
      result.content as Array<{ type: string; text?: string }>
    ).find((c) => c.type === 'text');
    expect(text?.text).toContain('Created branch');

    await client.close();
  });

  it('does not ask for approval for a read-only tool', async () => {
    const { client, transport, elicitations } = await connect(() => ({
      action: 'accept',
      content: { confirm: true },
    }));

    await waitForSseStream(transport);

    const result = await client.callTool({
      name: 'list_deployments',
      arguments: { limit: 3 },
    });

    expect(result.isError).toBeFalsy();
    // No elicitation was needed.
    expect(elicitations).toHaveLength(0);

    await client.close();
  });
});
