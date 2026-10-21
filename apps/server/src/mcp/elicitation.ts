import type { ElicitationCapable, ElicitationRequest } from '../ai/approval-gate.js';

/**
 * Adapts an MCP server's `elicitInput` to the narrow interface the
 * approval gate depends on.
 *
 * The gate lives in `src/ai/` and must not import the MCP transport, so it
 * declares its own minimal `ElicitationCapable` interface. The MCP layer
 * provides the implementation, and this adapter is the seam between them.
 *
 * The adapter is created **per session**, from that session's
 * `McpServer` instance. An approval request therefore always reaches the
 * client that opened the session — there is no global server and no way
 * for one session's approval to reach another.
 */

/** The shape of the SDK's `Server`, narrowed to what we use. */
interface ElicitingServer {
  elicitInput(
    params: {
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
    },
    options?: { timeout?: number },
  ): Promise<unknown>;
}

export interface ElicitationSourceOptions {
  /**
   * How long the SDK waits for the client to answer.
   *
   * The SDK applies this to the `elicitation/create` request itself, so
   * a client that never answers fails fast instead of holding the tool
   * call open until the outer gate timeout.
   */
  timeoutMs?: number;
}

export function createElicitationSource(
  server: ElicitingServer,
  options: ElicitationSourceOptions = {},
): ElicitationCapable {
  const timeoutMs = options.timeoutMs;

  return {
    async elicitInput(request: ElicitationRequest) {
      const result = (await server.elicitInput(
        {
          mode: 'form',
          message: request.message,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: {
                type: 'boolean',
                title: request.title,
                description: request.description,
                default: false,
              },
            },
            required: ['confirm'],
          },
        },
        timeoutMs !== undefined ? { timeout: timeoutMs } : undefined,
      )) as {
        action: 'accept' | 'decline' | 'cancel';
        content?: Record<string, unknown>;
      };

      return {
        action: result.action,
        ...(result.content ? { content: result.content } : {}),
      };
    },
  };
}
