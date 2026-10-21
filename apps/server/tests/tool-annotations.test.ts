import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { McpHttpHandler } from '../src/mcp/http-handler.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { createMockOpsAdapters } from '../src/tools/ops/mock.js';
import { buildCatalogue, toJson, toHealthJson } from '../src/tools/catalogue.js';
import express from 'express';
import { createApiRouter } from '../src/http/api.js';

/**
 * The tool annotations.
 *
 * "Destructive" (needs approval) and "read-only" (does not write) are
 * **different axes**. MCP publishes both, and a client uses `readOnlyHint`
 * to decide whether a call is safe to make unattended — so publishing a
 * write tool as read-only is a protocol lie.
 */

/** The tools that do not write. */
const READ_ONLY = [
  'echo',
  'list_deployments',
  'get_deployment',
  'get_ci_failure',
  'list_issues',
  'diagnose_incident',
];

/** The tools that write. */
const WRITE = [
  'create_issue',
  'comment_on_issue',
  'create_branch',
  'open_pull_request',
];

/** The tools that need the user's approval. */
const DESTRUCTIVE = ['create_branch', 'open_pull_request'];

describe('the catalogue axes', () => {
  it('marks the read-only tools as not writing', () => {
    const catalogue = buildCatalogue(
      new ToolRegistry().registerAll(createTools()).list(),
    );
    const byName = new Map(catalogue.map((entry) => [entry.name, entry]));

    for (const name of READ_ONLY) {
      expect(byName.get(name), `${name} is missing`).toBeDefined();
      expect(byName.get(name)!.writes, `${name} should not write`).toBe(false);
    }
  });

  it('marks the write tools as writing', () => {
    const catalogue = buildCatalogue(
      new ToolRegistry().registerAll(createTools()).list(),
    );
    const byName = new Map(catalogue.map((entry) => [entry.name, entry]));

    for (const name of WRITE) {
      expect(byName.get(name), `${name} is missing`).toBeDefined();
      expect(byName.get(name)!.writes, `${name} should write`).toBe(true);
    }
  });

  it('keeps destructive exactly as it was', () => {
    const catalogue = buildCatalogue(
      new ToolRegistry().registerAll(createTools()).list(),
    );

    const destructive = catalogue
      .filter((entry) => entry.destructive)
      .map((entry) => entry.name)
      .sort();

    expect(destructive).toEqual([...DESTRUCTIVE].sort());
  });

  it('keeps the two axes independent', () => {
    const catalogue = buildCatalogue(
      new ToolRegistry().registerAll(createTools()).list(),
    );
    const byName = new Map(catalogue.map((entry) => [entry.name, entry]));

    // A write that is not destructive: it writes, but it does not need
    // approval.
    expect(byName.get('create_issue')?.writes).toBe(true);
    expect(byName.get('create_issue')?.destructive).toBe(false);

    // A destructive tool is also a write.
    expect(byName.get('create_branch')?.writes).toBe(true);
    expect(byName.get('create_branch')?.destructive).toBe(true);
  });

  it('renders readOnly on the REST shapes', () => {
    const catalogue = buildCatalogue(
      new ToolRegistry().registerAll(createTools()).list(),
    );

    const full = catalogue.map(toJson);
    const compact = catalogue.map(toHealthJson);

    for (const name of READ_ONLY) {
      expect(full.find((t) => t.name === name)?.readOnly).toBe(true);
      expect(compact.find((t) => t.name === name)?.readOnly).toBe(true);
    }
    for (const name of WRITE) {
      expect(full.find((t) => t.name === name)?.readOnly).toBe(false);
      expect(compact.find((t) => t.name === name)?.readOnly).toBe(false);
    }
  });
});

describe('the MCP annotations and the REST catalogue agree', () => {
  let httpServer: Server;
  let apiServer: Server;
  let apiUrl: string;
  let mcpUrl: string;

  beforeAll(async () => {
    const registry = new ToolRegistry().registerAll(createTools());
    const mcpHandler = new McpHttpHandler(registry, createMockOpsAdapters());

    httpServer = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : undefined;
        const expressReq = Object.assign(req, { body }) as never;
        await mcpHandler.handle(expressReq, res as never);
      })();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    mcpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createApiRouter({
        registry,
        provider: null,
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
      }),
    );
    apiServer = createServer(app);
    await new Promise<void>((resolve) => apiServer.listen(0, resolve));
    apiUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  });

  it('publishes readOnlyHint for exactly the six read-only tools', async () => {
    const client = new Client(
      { name: 'annotation-test-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client.connect(transport);
    const { tools } = await client.listTools();

    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of READ_ONLY) {
      const tool = byName.get(name);
      expect(tool, `${name} is missing`).toBeDefined();
      expect(
        tool!.annotations?.readOnlyHint,
        `${name} should be read-only`,
      ).toBe(true);
    }

    for (const name of WRITE) {
      const tool = byName.get(name);
      expect(tool, `${name} is missing`).toBeDefined();
      expect(
        tool!.annotations?.readOnlyHint,
        `${name} writes, so it must not be read-only`,
      ).toBe(false);
    }

    await client.close();
  });

  it('still marks exactly two tools destructive', async () => {
    const client = new Client(
      { name: 'annotation-test-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client.connect(transport);
    const { tools } = await client.listTools();

    const destructive = tools
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();

    expect(destructive).toEqual([...DESTRUCTIVE].sort());

    await client.close();
  });

  it('agrees with the REST catalogue on both flags', async () => {
    const client = new Client(
      { name: 'annotation-test-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client.connect(transport);
    const { tools } = await client.listTools();

    const restBody = (await (
      await fetch(`${apiUrl}/tools`)
    ).json()) as {
      tools: Array<{ name: string; readOnly: boolean; destructive: boolean }>;
    };

    expect(restBody.tools).toHaveLength(tools.length);

    for (const tool of tools) {
      const rest = restBody.tools.find((t) => t.name === tool.name);
      expect(rest, `${tool.name} is missing from the REST catalogue`).toBeDefined();
      expect(rest!.readOnly).toBe(tool.annotations?.readOnlyHint === true);
      expect(rest!.destructive).toBe(tool.annotations?.destructiveHint === true);
    }

    await client.close();
  });
});
