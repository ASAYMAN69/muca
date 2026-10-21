import express, { type Express } from 'express';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';

import { loadConfig, type AppConfig } from './config.js';
import { REPO_ROOT, WEB_DIR, APP_ROOT } from './paths.js';
import { API_PREFIX, createApiRouter, type TaskSnapshotLike } from './http/api.js';
import { McpHttpHandler } from './mcp/http-handler.js';
import { ToolRegistry } from './tools/registry.js';
import { createTools } from './tools/index.js';
import { createMockOpsAdapters } from './tools/ops/mock.js';
import type { OpsAdapters } from './tools/ops/types.js';
import type { AIProvider } from './ai/provider.js';
import { createProvider } from './ai/provider-factory.js';
import { gatewayInput, selectProvider, type GatewayDecision } from './ai/gateway.js';
import type { ProbeResult } from './ai/probe.js';
import type { AiState } from './ai/ai-state.js';
import { SYSTEM_PROMPT } from './ai/prompt.js';
import {
  RunHistoryStore,
  defaultRunHistoryDir,
} from './store/run-history.js';
import { PendingApprovalRegistry } from './store/pending-approvals.js';
import { isTerminalStatus, type TaskStatus } from './mcp/tasks.js';

export interface BuiltServer {
  app: Express;
  httpServer: ReturnType<typeof createHttpServer>;
  config: AppConfig;
  registry: ToolRegistry;
  mcp: McpHttpHandler;
  runHistory: RunHistoryStore;
  /** The gateway's decision: which provider is in use, and how it went. */
  ai: AiState;
  close: () => Promise<void>;
}

/**
 * Builds the single Express application that serves BOTH:
 *   /api/v1/*  -> REST API + the MCP Streamable HTTP endpoint
 *   /*         -> the Next.js frontend
 *
 * One port, one process. `next` is mounted as the terminal middleware, so
 * anything the API does not claim is handled by the Next.js request handler.
 */
export async function buildServer(): Promise<BuiltServer> {
  const config = loadConfig();

  const adapters: OpsAdapters = createMockOpsAdapters();
  const registry = new ToolRegistry().registerAll(createTools(adapters));
  const mcp = new McpHttpHandler(registry, adapters);

  // The gateway probes every configured endpoint in parallel and picks
  // the highest-priority one that actually answers.
  const decision: GatewayDecision = await selectProvider(gatewayInput(config));
  const ai: AiState = {
    enabled: decision.enabled,
    provider: decision.selected,
    model: decision.model,
    mode: config.ai.mode,
    selectedAt: new Date().toISOString(),
    probes: decision.probes,
  };

  // The config records what the gateway decided, so everything that reads
  // the config sees the same truth.
  config.ai.selected = decision.selected;
  config.ai.model = decision.model;
  config.ai.enabled = decision.enabled;

  const provider: AIProvider | null = createProvider(config, decision.selected);

  const runHistory = new RunHistoryStore(
    config.runHistoryDir
      ? resolve(REPO_ROOT, config.runHistoryDir)
      : defaultRunHistoryDir(APP_ROOT),
  );
  runHistory.init();

  const pendingApprovals = new PendingApprovalRegistry();

  const app = express();

  app.disable('x-powered-by');

  // The MCP transport needs the raw JSON body, and it also accepts a
  // pre-parsed body. We parse it here and pass `req.body` through.
  app.use(API_PREFIX, express.json({ limit: '4mb' }));

  // Permissive CORS: the frontend is same-origin, but MCP clients and
  // local tooling frequently call the API from a different origin.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, MCP-Protocol-Version');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(`${API_PREFIX}/mcp`, (req, res) => {
    void mcp.handle(req, res);
  });

  app.use(
    API_PREFIX,
    createApiRouter({
      registry,
      provider,
      systemPrompt: SYSTEM_PROMPT,
      protocolVersion: config.mcp.protocolVersion,
      mcpUrl: config.mcp.publicUrl,
      runHistory,
      pendingApprovals,
      getTask: readTask,
      listTasks: listTasks,
      ai,
      probe: () => reProbe(config),
    }),
  );

  // Everything else is the Next.js frontend.
  // `next` is a CommonJS module whose export *is* the factory function.
  const nextModule = await import('next');
  const next = nextModule.default as unknown as (options: {
    dev: boolean;
    dir: string;
    hostname: string;
    port: number;
  }) => {
    getRequestHandler: () => (
      req: IncomingMessage,
      res: ServerResponse,
    ) => Promise<void>;
    prepare: () => Promise<void>;
    close?: () => Promise<void>;
  };

  const nextApp = next({
    dev: config.nodeEnv !== 'production',
    dir: WEB_DIR,
    hostname: '127.0.0.1',
    port: config.port,
  });
  const handle = nextApp.getRequestHandler();
  await nextApp.prepare();

  app.use((req, res) => {
    void handle(req, res);
  });

  const httpServer = createHttpServer(app);

  const close = async () => {
    await mcp.closeAll();
    await new Promise<void>((resolveClose) => {
      httpServer.close(() => resolveClose());
    });
    await nextApp.close?.();
  };

  return { app, httpServer, config, registry, mcp, runHistory, ai, close };

  /* ------------------------------------------------------------------ */
  /* Task helpers                                                       */
  /* ------------------------------------------------------------------ */

  /**
   * Reads a task from the shared task store and shapes it for the REST
   * API.
   */
  async function readTask(taskId: string): Promise<TaskSnapshotLike | null> {
    const task = await mcp.taskStore.getTask(taskId);
    if (!task) return null;

    const snapshot: TaskSnapshotLike = {
      taskId: task.taskId,
      status: task.status,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    };

    if (isTerminalStatus(task.status)) {
      try {
        const result = await mcp.taskStore.getTaskResult(taskId);
        snapshot.result = result;
      } catch {
        // A task that failed may have no stored result.
        snapshot.error = task.statusMessage ?? `Task ${task.status}.`;
      }
    }

    return snapshot;
  }

  /** Lists the known tasks, newest first. */
  async function listTasks(): Promise<TaskSnapshotLike[]> {
    const { tasks } = await mcp.taskStore.listTasks();
    return tasks.map((task) => ({
      taskId: task.taskId,
      status: task.status as TaskStatus,
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ...(task.statusMessage ? { statusMessage: task.statusMessage } : {}),
    }));
  }

  /**
   * Re-runs the probes.
   *
   * This is a **diagnostic**, not a hot-swap: the provider in use for
   * this process does not change. The response says so explicitly.
   */
  async function reProbe(
    current: AppConfig,
  ): Promise<{ probes: ProbeResult[]; applied: false; decision: GatewayDecision }> {
    const decision = await selectProvider(gatewayInput(current));
    return { probes: decision.probes, applied: false, decision };
  }
}

/** Starts the server. Used by `src/index.ts` and by the integration tests. */
export async function startServer(): Promise<BuiltServer> {
  const built = await buildServer();
  await new Promise<void>((resolve) => {
    built.httpServer.listen(built.config.port, resolve);
  });
  return built;
}
