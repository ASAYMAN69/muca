import express, { type Express } from 'express';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadConfig, type AppConfig } from './config.js';
import { loadEnv, WEB_DIR } from './paths.js';
import { API_PREFIX, createApiRouter } from './http/api.js';
import { McpHttpHandler } from './mcp/http-handler.js';
import { ToolRegistry } from './tools/registry.js';
import { createTools } from './tools/index.js';
import { OpenAIProvider } from './ai/openai-provider.js';
import type { AIProvider } from './ai/provider.js';
import { SYSTEM_PROMPT } from './ai/prompt.js';

export interface BuiltServer {
  app: Express;
  httpServer: ReturnType<typeof createHttpServer>;
  config: AppConfig;
  registry: ToolRegistry;
  mcp: McpHttpHandler;
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

  const registry = new ToolRegistry().registerAll(createTools());
  const mcp = new McpHttpHandler(registry);

  const provider: AIProvider | null = config.ai.enabled
    ? new OpenAIProvider({
        apiKey: config.ai.apiKey,
        baseUrl: config.ai.baseUrl,
        model: config.ai.model,
      })
    : null;

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

  return { app, httpServer, config, registry, mcp, close };
}

/** Starts the server. Used by `src/index.ts` and by the integration tests. */
export async function startServer(): Promise<BuiltServer> {
  const built = await buildServer();
  await new Promise<void>((resolve) => {
    built.httpServer.listen(built.config.port, resolve);
  });
  return built;
}
