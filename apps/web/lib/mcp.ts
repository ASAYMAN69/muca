/**
 * A real MCP client, running in the browser.
 *
 * This is the official `@modelcontextprotocol/sdk` client speaking the
 * Streamable HTTP transport to our own `/api/v1/mcp` endpoint. It is the
 * same transport a judge's own MCP host would use, so the panel shows a
 * genuine protocol exchange rather than a mock.
 *
 * Verified to work in the browser bundle: the SDK's client transport only
 * needs `fetch`, `ReadableStream` and `TextDecoderStream`, all of which
 * exist in every browser that can run this app.
 *
 * The panel needs two things the plain SDK client does not give us:
 *   - the raw JSON-RPC messages, so we can show the wire traffic, and
 *   - the session id, so a judge can correlate it with the server.
 *
 * Both come from wrapping the transport: we intercept `send` and
 * `onmessage` rather than patching the SDK.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** The MCP endpoint, relative to the app origin. Never an absolute URL. */
export const MCP_ENDPOINT = '/api/v1/mcp';

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  /** The tool is destructive and needs an explicit approval. */
  destructive: boolean;
  readOnly?: boolean;
  inputSchema?: Record<string, unknown>;
}

export interface McpLogEntry {
  id: string;
  /** Wall-clock time the message was seen. */
  at: string;
  /** `request` or `response`. */
  direction: 'out' | 'in';
  /** The JSON-RPC method, for requests. */
  method?: string;
  /** The JSON-RPC id, when there is one. */
  rpcId?: string | number;
  /** The pretty-printed payload. */
  payload: string;
}

export type McpConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'failed';

export interface McpSession {
  status: McpConnectionStatus;
  /** The negotiated protocol version, from the `initialize` result. */
  protocolVersion?: string;
  /** The server's own name and version. */
  serverInfo?: { name: string; version: string };
  /** The server's advertised capabilities. */
  capabilities?: Record<string, unknown>;
  /** The server's instructions, if it sent any. */
  instructions?: string;
  /** The `Mcp-Session-Id` the server assigned. */
  sessionId?: string;
  /** The tools the server published. */
  tools: McpTool[];
  /** The raw JSON-RPC traffic, newest last. */
  log: McpLogEntry[];
  /** The error, when the connection failed. */
  error?: string;
}

const MAX_LOG_ENTRIES = 200;

/**
 * A live MCP client bound to one browser session.
 *
 * The instance owns the SDK client, the transport and the log. `dispose`
 * tears the session down so the server releases it.
 */
export class McpBrowserClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private logEntries: McpLogEntry[] = [];
  private counter = 0;
  private disposed = false;
  private session: McpSession = {
    status: 'idle',
    tools: [],
    log: [],
  };

  constructor(
    private readonly onUpdate: (session: McpSession) => void,
    private readonly endpoint: string = MCP_ENDPOINT,
  ) {}

  /**
   * Performs the full handshake: `initialize` → `notifications/initialized`
   * → `tools/list`.
   */
  async connect(): Promise<void> {
    this.disposed = false;
    this.patch({ status: 'connecting', error: undefined });

    const client = new Client(
      { name: 'muca-web', version: '1.0.0' },
      { capabilities: {} },
    );
    this.client = client;

    // The transport is created with a relative URL resolved against the
    // current origin, so the browser never sees an absolute backend URL.
    const url = new URL(this.endpoint, window.location.origin);
    const transport = new StreamableHTTPClientTransport(url);
    this.transport = transport;

    this.interceptTransport(transport);

    try {
      await client.connect(transport);

      const serverInfo = client.getServerVersion();
      const capabilities = client.getServerCapabilities() as
        | Record<string, unknown>
        | undefined;

      this.patch({
        status: 'connected',
        protocolVersion: transport.protocolVersion,
        serverInfo: serverInfo
          ? { name: serverInfo.name, version: serverInfo.version }
          : undefined,
        capabilities: capabilities ?? undefined,
        instructions: client.getInstructions(),
        sessionId: transport.sessionId,
      });

      const listed = await client.listTools();
      this.patch({
        tools: listed.tools.map((tool) => ({
          name: tool.name,
          title: tool.title ?? tool.name,
          description: tool.description ?? '',
          destructive: tool.annotations?.destructiveHint === true,
          readOnly: tool.annotations?.readOnlyHint === true,
          inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
        })),
      });
    } catch (error) {
      this.patch({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Calls a tool over MCP and returns the result.
   *
   * The traffic shows up in the log, so the panel proves the tool call
   * really travelled over the protocol.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ ok: boolean; text: string }> {
    if (!this.client) {
      return { ok: false, text: 'Not connected.' };
    }
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const parts = Array.isArray(result.content) ? result.content : [];
      const text = parts
        .map((part) => {
          if (part && typeof part === 'object' && 'text' in part) {
            return String((part as { text: unknown }).text);
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      return { ok: !result.isError, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patch({ error: message });
      return { ok: false, text: message };
    }
  }

  /** Closes the session. Safe to call more than once. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.client?.close();
    } catch {
      // The transport may already be closed. Nothing to do.
    }
    this.client = null;
    this.transport = null;
    this.patch({ status: 'idle', sessionId: undefined });
  }

  /**
   * Records the JSON-RPC traffic.
   *
   * We read the payload from the transport rather than the SDK so the log
   * shows exactly what went over the wire, including the `initialize`
   * request the SDK sends.
   */
  private interceptTransport(transport: StreamableHTTPClientTransport): void {
    const originalSend = transport.send.bind(transport);
    transport.send = async (message, options) => {
      this.record('out', message);
      return originalSend(message, options);
    };

    const originalOnMessage = transport.onmessage;
    transport.onmessage = (message: JSONRPCMessage) => {
      this.record('in', message);
      originalOnMessage?.(message);
    };
  }

  private record(
    direction: 'out' | 'in',
    message: JSONRPCMessage | JSONRPCMessage[],
  ): void {
    const messages = Array.isArray(message) ? message : [message];
    for (const single of messages) {
      this.recordOne(direction, single);
    }
  }

  private recordOne(direction: 'out' | 'in', message: JSONRPCMessage): void {
    const record = message as {
      method?: string;
      id?: string | number;
    };
    const entry: McpLogEntry = {
      id: `m${++this.counter}`,
      at: new Date().toISOString(),
      direction,
      method: record.method,
      rpcId: record.id,
      payload: safeStringify(message),
    };

    this.logEntries = [...this.logEntries, entry].slice(-MAX_LOG_ENTRIES);
    this.patch({ log: this.logEntries });
  }

  private patch(partial: Partial<McpSession>): void {
    this.session = {
      ...this.session,
      ...partial,
      tools: partial.tools ?? this.session.tools,
      log: partial.log ?? this.session.log,
    };
    this.onUpdate(this.session);
  }
}

/** JSON.stringify that never throws on a circular structure. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
