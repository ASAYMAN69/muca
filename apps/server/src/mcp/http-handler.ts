import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';
import type { Request, Response } from 'express';

import { createMcpServer } from './server.js';
import { TaskRunner } from './tasks.js';
import { ToolRegistry } from '../tools/registry.js';
import type { OpsAdapters } from '../tools/ops/types.js';

/**
 * Sends a JSON-RPC error response.
 *
 * Uses the raw Node response API rather than `res.status().json()` so the
 * handler works both inside Express and behind a bare `http.createServer`
 * (which is what the tests use).
 */
function sendJsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Mounts the MCP Streamable HTTP endpoint on an Express router.
 *
 * The server runs in **stateful** mode: each client gets a session id and
 * subsequent requests must carry it back in the `Mcp-Session-Id` header.
 * This is the mode the MCP spec recommends for servers that hold state, and
 * it is what real MCP clients (and the Alexa+ hackathon reviewers) expect to
 * be able to inspect via `initialize` -> `tools/list` -> `tools/call`.
 *
 * Session lifecycle:
 *   POST /mcp  (initialize)  -> creates a session, returns `Mcp-Session-Id`
 *   POST /mcp  (subsequent)  -> routed to the session's transport
 *   GET  /mcp                -> opens the server->client SSE stream
 *   DELETE /mcp              -> tears the session down
 *
 * The request body must already be parsed and available on `req.body`.
 */
export class McpHttpHandler {
  /** sessionId -> transport */
  private readonly sessions = new Map<string, StreamableHTTPServerTransport>();
  /** sessionId -> the MCP server instance for that session. */
  private readonly servers = new Map<string, McpServerHandle>();

  /**
   * The task store is shared across sessions so the REST task endpoint can
   * see the tasks an MCP client started.
   */
  readonly taskStore = new InMemoryTaskStore();

  /** The background runner that drives long-running tasks. */
  readonly taskRunner = new TaskRunner();

  constructor(
    private readonly registry: ToolRegistry,
    private readonly adapters: OpsAdapters,
  ) {}

  /** All currently open session ids. Used by the health endpoint + tests. */
  get activeSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Express handler for every HTTP method the transport supports.
   */
  handle = async (req: Request, res: Response): Promise<void> => {
    const { method } = req;

    if (method === 'POST') {
      await this.handlePost(req, res);
      return;
    }

    if (method === 'GET') {
      await this.handleGet(req, res);
      return;
    }

    if (method === 'DELETE') {
      this.handleDelete(req, res);
      return;
    }

    sendJsonRpcError(res, 405, -32000, 'Method not allowed');
  };

  private async handlePost(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
      const transport = this.sessions.get(sessionId);
      if (!transport) {
        sendJsonRpcError(res, 404, -32001, `Unknown session: ${sessionId}`);
        return;
      }
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // No session id: this must be an `initialize` request.
    if (!isInitializeRequest(req.body)) {
      sendJsonRpcError(
        res,
        400,
        -32000,
        'Bad Request: no valid session ID provided. Send an initialize request first.',
      );
      return;
    }

    // A fresh MCP server per session. The elicitation gate is built from
    // this instance, so an approval can never leak between sessions.
    const { server } = createMcpServer({
      registry: this.registry,
      adapters: this.adapters,
      taskRunner: this.taskRunner,
      taskStore: this.taskStore,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        this.sessions.set(id, transport);
        // The session id only exists once the initialize request has
        // been handled, so the server is registered here rather than
        // before the connect.
        this.servers.set(id, server.server);
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
        this.servers.delete(id);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        this.sessions.delete(transport.sessionId);
        this.servers.delete(transport.sessionId);
      }
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }

  private async handleGet(req: Request, res: Response): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      sendJsonRpcError(
        res,
        400,
        -32000,
        'Bad Request: missing Mcp-Session-Id header',
      );
      return;
    }

    const transport = this.sessions.get(sessionId);
    if (!transport) {
      sendJsonRpcError(res, 404, -32001, `Unknown session: ${sessionId}`);
      return;
    }

    await transport.handleRequest(req, res);
  }

  private handleDelete(req: Request, res: Response): void {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
      sendJsonRpcError(
        res,
        400,
        -32000,
        'Bad Request: missing Mcp-Session-Id header',
      );
      return;
    }

    const transport = this.sessions.get(sessionId);
    if (!transport) {
      sendJsonRpcError(res, 404, -32001, `Unknown session: ${sessionId}`);
      return;
    }

    this.sessions.delete(sessionId);
    this.servers.delete(sessionId);
    void transport.close();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }

  /**
   * The MCP server instance for a session, if it is still open.
   *
   * This is how the approval gate reaches the *current* session's server
   * without a global singleton: the caller passes the session id and gets
   * that session's server, or nothing.
   */
  serverForSession(sessionId: string): McpServerHandle | undefined {
    return this.servers.get(sessionId);
  }

  /** Closes every open session. Called on server shutdown. */
  async closeAll(): Promise<void> {
    const transports = [...this.sessions.values()];
    this.sessions.clear();
    this.servers.clear();
    this.taskRunner.cancelAll();
    this.taskStore.cleanup();
    await Promise.all(transports.map((t) => t.close()));
  }
}

/**
 * The per-session MCP server.
 *
 * The `McpServer` wrapper exposes the low-level `Server` on `.server`, and
 * that is where `elicitInput` lives. Only that one method is needed by the
 * approval gate.
 */
export interface McpServerHandle {
  elicitInput(params: {
    mode?: 'form';
    message: string;
    requestedSchema: {
      type: 'object';
      properties: {
        [key: string]: {
          type: 'boolean';
          title?: string;
          description?: string;
          default?: boolean;
        };
      };
      required?: string[];
    };
  }): Promise<unknown>;
}
