import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { createApiRouter } from '../src/http/api.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import type { AIProvider, ProviderResponse } from '../src/ai/provider.js';

/** A provider that always requests the `echo` tool once, then answers. */
class EchoProvider implements AIProvider {
  readonly name = 'echo-provider';
  private turn = 0;

  async chat(): Promise<ProviderResponse> {
    this.turn += 1;
    if (this.turn === 1) {
      return {
        content: null,
        toolCalls: [
          { id: 'call_1', name: 'echo', arguments: '{"message":"from tool"}' },
        ],
        finishReason: 'tool_calls',
      };
    }
    return {
      content: 'The tool said: from tool',
      toolCalls: [],
      finishReason: 'stop',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

interface ToolSummary {
  name: string;
  destructive: boolean;
  inputSchema?: unknown;
}

interface HealthBody {
  status: string;
  mcp: { protocolVersion: string };
  ai: { enabled: boolean };
  tools: ToolSummary[];
}

interface ToolsBody {
  tools: ToolSummary[];
}

interface ChatBody {
  text: string;
  awaitingConfirmation: boolean;
  events: Array<{ type: string }>;
}

interface ErrorBody {
  error: string;
  details?: unknown[];
}

describe('REST API', () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const registry = new ToolRegistry().registerAll(createTools());
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createApiRouter({
        registry,
        provider: new EchoProvider(),
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
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

  it('GET /health reports status, protocol version and the tool list', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as HealthBody;
    expect(body.status).toBe('ok');
    expect(body.mcp.protocolVersion).toBe('2025-11-25');
    expect(body.ai.enabled).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools.find((t) => t.name === 'create_branch')?.destructive).toBe(true);
  });

  it('GET /tools returns the catalogue with input schemas', async () => {
    const response = await fetch(`${baseUrl}/tools`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as ToolsBody;
    const echo = body.tools.find((t) => t.name === 'echo');
    expect(echo).toBeDefined();
    expect(echo?.inputSchema).toBeDefined();
  });

  it('POST /chat runs the agent and returns events', async () => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'echo something', history: [] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as ChatBody;
    expect(body.text).toBe('The tool said: from tool');
    expect(body.awaitingConfirmation).toBe(false);
    expect(body.events.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('POST /chat rejects an empty message with 400', async () => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '', history: [] }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorBody;
    expect(body.error).toBe('Invalid request body');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('POST /chat returns 503 when the AI provider is not configured', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createApiRouter({
        registry: new ToolRegistry().registerAll(createTools()),
        provider: null,
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
      }),
    );

    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', history: [] }),
    });

    expect(response.status).toBe(503);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
