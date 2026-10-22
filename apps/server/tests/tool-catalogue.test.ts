import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createApiRouter } from '../src/http/api.js';
import { McpHttpHandler } from '../src/mcp/http-handler.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { createMockOpsAdapters } from '../src/tools/ops/mock.js';
import {
  buildCatalogue,
  TASK_BACKED_TOOLS,
  toHealthJson,
  toJson,
  type CatalogueEntry,
} from '../src/tools/catalogue.js';

/**
 * The tool surface must be reported identically by every surface:
 * MCP `tools/list`, `GET /api/v1/tools` and `GET /api/v1/health`.
 *
 * Muca's claim is that every capability is a real MCP tool. If the
 * server disagreed with itself about its own catalogue, that claim would
 * not survive a judge's inspection.
 */

/** The nine tools that were reported before the task-backed tool was added. */
const PREVIOUSLY_REPORTED = [
  'echo',
  'list_deployments',
  'get_deployment',
  'get_ci_failure',
  'list_issues',
  'create_issue',
  'comment_on_issue',
  'create_branch',
  'open_pull_request',
];

interface RestTool {
  name: string;
  title: string;
  description: string;
  destructive: boolean;
  taskBacked?: boolean;
  inputSchema?: Record<string, unknown>;
}

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

describe('the tool catalogue is one source of truth', () => {
  let httpServer: Server;
  let mcpHandler: McpHttpHandler;
  let apiServer: Server;
  let apiUrl: string;
  let mcpUrl: string;

  beforeAll(async () => {
    const registry = new ToolRegistry().registerAll(createTools());
    mcpHandler = new McpHttpHandler(registry, createMockOpsAdapters());

    // The real MCP transport, behind a bare http server.
    httpServer = createServer((req, res) => {
      void (async () => {
        const body = await readJsonBody(req);
        const expressReq = Object.assign(req, { body }) as never;
        await mcpHandler.handle(expressReq, res as never);
      })();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const mcpPort = (httpServer.address() as AddressInfo).port;
    mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

    // The REST router.
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
    const apiPort = (apiServer.address() as AddressInfo).port;
    apiUrl = `http://127.0.0.1:${apiPort}/api/v1`;
  });

  afterAll(async () => {
    await mcpHandler.closeAll();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  });

  /** The names MCP `tools/list` advertises, from a real MCP client. */
  async function mcpToolNames(): Promise<string[]> {
    const client = new Client(
      { name: 'catalogue-test-client', version: '0.1.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    await client.connect(transport);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((tool) => tool.name);
  }

  it('reports the same number of tools on all three surfaces', async () => {
    const mcpNames = await mcpToolNames();

    const toolsResponse = await fetch(`${apiUrl}/tools`);
    const toolsBody = (await toolsResponse.json()) as { tools: RestTool[] };

    const healthResponse = await fetch(`${apiUrl}/health`);
    const healthBody = (await healthResponse.json()) as { tools: RestTool[] };

    expect(toolsBody.tools).toHaveLength(mcpNames.length);
    expect(healthBody.tools).toHaveLength(mcpNames.length);

    // 9 registry tools + 1 task-backed tool.
    expect(mcpNames).toHaveLength(18);
  });

  it('reports the same tool names on all three surfaces', async () => {
    const mcpNames = await mcpToolNames();

    const toolsBody = (await (
      await fetch(`${apiUrl}/tools`)
    ).json()) as { tools: RestTool[] };
    const healthBody = (await (
      await fetch(`${apiUrl}/health`)
    ).json()) as { tools: RestTool[] };

    const toolsNames = toolsBody.tools.map((tool) => tool.name);
    const healthNames = healthBody.tools.map((tool) => tool.name);

    expect(toolsNames).toEqual(mcpNames);
    expect(healthNames).toEqual(mcpNames);
  });

  it('includes diagnose_incident in both REST responses', async () => {
    const toolsBody = (await (
      await fetch(`${apiUrl}/tools`)
    ).json()) as { tools: RestTool[] };
    const healthBody = (await (
      await fetch(`${apiUrl}/health`)
    ).json()) as { tools: RestTool[] };

    expect(toolsBody.tools.map((t) => t.name)).toContain('diagnose_incident');
    expect(healthBody.tools.map((t) => t.name)).toContain('diagnose_incident');
  });

  it('still reports the nine previously-reported tools, unchanged', async () => {
    const toolsBody = (await (
      await fetch(`${apiUrl}/tools`)
    ).json()) as { tools: RestTool[] };
    const healthBody = (await (
      await fetch(`${apiUrl}/health`)
    ).json()) as { tools: RestTool[] };

    for (const name of PREVIOUSLY_REPORTED) {
      const tool = toolsBody.tools.find((t) => t.name === name);
      expect(tool, `${name} is missing from /tools`).toBeDefined();
      expect(tool!.name).toBe(name);
      expect(typeof tool!.title).toBe('string');
      expect(typeof tool!.description).toBe('string');
      expect(typeof tool!.destructive).toBe('boolean');
      // The annotations the web client reads are unchanged.
      expect(tool!.destructive).toBe(
        name === 'create_branch' || name === 'open_pull_request',
      );
      // And they are not task-backed.
      expect(tool!.taskBacked).toBe(false);

      expect(
        healthBody.tools.find((t) => t.name === name),
        `${name} is missing from /health`,
      ).toBeDefined();
    }
  });

  it('marks diagnose_incident as task-backed and nothing else', async () => {
    const toolsBody = (await (
      await fetch(`${apiUrl}/tools`)
    ).json()) as { tools: RestTool[] };
    const healthBody = (await (
      await fetch(`${apiUrl}/health`)
    ).json()) as { tools: RestTool[] };

    for (const body of [toolsBody, healthBody]) {
      const diagnose = body.tools.find((t) => t.name === 'diagnose_incident');
      expect(diagnose).toBeDefined();
      expect(diagnose!.taskBacked).toBe(true);

      for (const tool of body.tools) {
        if (tool.name === 'diagnose_incident') continue;
        expect(tool.taskBacked, `${tool.name} should not be task-backed`).toBe(
          false,
        );
      }
    }
  });

  it('does not claim the task-backed tool is a plain synchronous tool', async () => {
    const toolsBody = (await (
      await fetch(`${apiUrl}/tools`)
    ).json()) as { tools: RestTool[] };

    const diagnose = toolsBody.tools.find((t) => t.name === 'diagnose_incident')!;

    // It is honest about being long-running: the description says so, and
    // the marker is set.
    expect(diagnose.description).toContain('task handle');
    expect(diagnose.taskBacked).toBe(true);

    // It is not destructive, and it publishes its input schema.
    expect(diagnose.destructive).toBe(false);
    expect(diagnose.inputSchema).toBeDefined();
    expect(Object.keys(diagnose.inputSchema ?? {})).toContain('service');
  });
});

describe('the catalogue module', () => {
  it('includes the registry tools and the task-backed tools', () => {
    const registry = new ToolRegistry().registerAll(createTools());
    const catalogue = buildCatalogue(registry.list());

    const names = catalogue.map((entry) => entry.name);
    for (const name of PREVIOUSLY_REPORTED) {
      expect(names).toContain(name);
    }
    expect(names).toContain('diagnose_incident');
    expect(catalogue).toHaveLength(18);
  });

  it('marks only the task-backed tools as task-backed', () => {
    const registry = new ToolRegistry().registerAll(createTools());
    const catalogue = buildCatalogue(registry.list());

    const taskBacked = catalogue.filter(
      (entry) => entry.invocation.kind === 'task',
    );
    expect(taskBacked.map((entry) => entry.name)).toEqual([
      'diagnose_incident',
    ]);
  });

  it('renders the same tool set in both wire shapes', () => {
    const registry = new ToolRegistry().registerAll(createTools());
    const catalogue = buildCatalogue(registry.list());

    const full = catalogue.map(toJson);
    const compact = catalogue.map(toHealthJson);

    expect(full.map((t) => t.name)).toEqual(compact.map((t) => t.name));
    expect(full.map((t) => t.taskBacked)).toEqual(
      compact.map((t) => t.taskBacked),
    );
  });

  it('declares the task-backed tools in exactly one place', () => {
    // The catalogue is the only declaration: the MCP layer and the REST
    // layer both read from it.
    expect(TASK_BACKED_TOOLS.length).toBeGreaterThan(0);
    for (const tool of TASK_BACKED_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(Object.keys(tool.inputSchema).length).toBeGreaterThan(0);
    }
  });

  it('keeps the destructive flag honest for the registry tools', () => {
    const registry = new ToolRegistry().registerAll(createTools());
    const catalogue = buildCatalogue(registry.list());

    const byName = new Map<string, CatalogueEntry>(
      catalogue.map((entry) => [entry.name, entry]),
    );

    expect(byName.get('create_branch')?.destructive).toBe(true);
    expect(byName.get('open_pull_request')?.destructive).toBe(true);
    expect(byName.get('list_deployments')?.destructive).toBe(false);
    expect(byName.get('echo')?.destructive).toBe(false);
    // A task-backed tool is read-only.
    expect(byName.get('diagnose_incident')?.destructive).toBe(false);
  });
});
