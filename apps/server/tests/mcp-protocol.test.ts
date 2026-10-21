import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { McpHttpHandler } from '../src/mcp/http-handler.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { createMockOpsAdapters } from '../src/tools/ops/mock.js';

/**
 * Reads and parses a JSON request body.
 * The MCP transport needs the parsed body, exactly like `express.json()`.
 */
async function readJsonBody(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * Boots a real HTTP server with the MCP Streamable HTTP transport and
 * connects a real MCP client to it. Nothing is stubbed: this exercises
 * initialize -> tools/list -> tools/call over the wire.
 */
describe('MCP server over Streamable HTTP', () => {
  let httpServer: Server;
  let handler: McpHttpHandler;
  let baseUrl: string;

  beforeAll(async () => {
    const registry = new ToolRegistry().registerAll(createTools());
    handler = new McpHttpHandler(registry, createMockOpsAdapters());

    httpServer = createServer((req, res) => {
      void (async () => {
        const body = await readJsonBody(req);
        // The handler expects an Express-shaped request/response. Keep the
        // original `req` object so `headers` and friends stay intact.
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
      { name: 'muca-test-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await client.connect(transport);
    return client;
  }

  it('completes the initialize handshake and negotiates a protocol version', async () => {
    const client = await connect();

    const serverVersion = client.getServerVersion();
    expect(serverVersion).toBeDefined();
    expect(serverVersion?.name).toBe('muca-mcp');

    // The negotiated version must be one the SDK knows about.
    const capabilities = client.getServerCapabilities();
    expect(capabilities).toBeDefined();
    expect(capabilities?.tools).toBeDefined();

    await client.close();
  });

  it('lists tools with JSON Schema input schemas', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('list_deployments');
    expect(names).toContain('create_branch');

    const echo = tools.find((t) => t.name === 'echo');
    expect(echo).toBeDefined();
    expect(echo!.description).toBeTruthy();

    const schema = echo!.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {})).toContain('message');
    expect(schema.required).toContain('message');

    await client.close();
  });

  it('marks destructive tools with the destructiveHint annotation', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    const createBranch = tools.find((t) => t.name === 'create_branch');
    expect(createBranch?.annotations?.destructiveHint).toBe(true);
    expect(createBranch?.annotations?.readOnlyHint).toBe(false);

    const echo = tools.find((t) => t.name === 'echo');
    expect(echo?.annotations?.destructiveHint).toBe(false);
    expect(echo?.annotations?.readOnlyHint).toBe(true);

    await client.close();
  });

  it('executes a tool and returns the result', async () => {
    const client = await connect();

    const result = await client.callTool({
      name: 'echo',
      arguments: { message: 'hello muca', repeat: 2 },
    });

    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === 'text',
    );
    expect(text?.text).toBe('hello muca hello muca');

    await client.close();
  });

  it('rejects invalid arguments with a tool error', async () => {
    const client = await connect();

    const result = await client.callTool({
      name: 'echo',
      arguments: { repeat: 5 },
    });

    expect(result.isError).toBe(true);

    await client.close();
  });

  it('rejects a call to an unknown tool', async () => {
    const client = await connect();

    // The MCP SDK surfaces an unknown tool as an error *result*, not a
    // transport-level rejection.
    const result = await client.callTool({
      name: 'does_not_exist',
      arguments: {},
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === 'text',
    );
    expect(text?.text).toContain('does_not_exist');

    await client.close();
  });

  it('round-trips state across tool calls in the same session', async () => {
    const client = await connect();

    const created = await client.callTool({
      name: 'create_issue',
      arguments: { title: 'Groceries', body: 'milk', labels: ['errands'] },
    });
    expect(created.isError).toBeFalsy();

    const list = await client.callTool({
      name: 'list_issues',
      arguments: { state: 'open' },
    });
    const text = (list.content as Array<{ type: string; text?: string }>).find(
      (c) => c.type === 'text',
    );
    expect(text?.text).toContain('Groceries');

    await client.close();
  });

  it('rejects a non-initialize POST that has no session id', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });

    expect(response.status).toBe(400);
  });
});
