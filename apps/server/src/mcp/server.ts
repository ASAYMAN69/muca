import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js';

import { ToolRegistry, type MucaTool } from '../tools/registry.js';
import type { OpsAdapters } from '../tools/ops/types.js';
import { registerTaskTools, type TaskRunner } from './tasks.js';
import {
  ElicitationApprovalGate,
  type ApprovalGate,
} from '../ai/approval-gate.js';
import { createElicitationSource } from './elicitation.js';

export const SERVER_NAME = 'muca-mcp';
export const SERVER_VERSION = '0.2.0';

/**
 * Builds the MCP server and registers every tool from the registry.
 *
 * The MCP server owns *protocol* concerns only: schema publication,
 * argument validation, task handles and elicitation. Actual behaviour
 * lives in the tool handlers, so the same tool implementation can be
 * reused by a non-MCP caller if needed.
 *
 * Two protocol-native features are wired up here:
 *
 *   - **Tasks.** The server carries a `taskStore`, which makes the SDK
 *     install its `tasks/get`, `tasks/list` and `tasks/cancel` handlers
 *     and lets the long-running `diagnose_incident` tool return a task
 *     handle instead of blocking.
 *   - **Elicitation.** A destructive tool is never run without the
 *     client's say-so. The server asks the *client* with
 *     `elicitation/create` and only runs the tool when the client
 *     accepts. Because the server instance is created per session, the
 *     approval always reaches the client that opened the session — there
 *     is no global server and no way for one session's approval to reach
 *     another.
 */
export interface McpServerDeps {
  registry: ToolRegistry;
  adapters: OpsAdapters;
  taskRunner: TaskRunner;
  /** The task store. Created by the caller so it can be shared. */
  taskStore?: InMemoryTaskStore;
  /**
   * How long to wait for the client to answer an elicitation before
   * giving up. Defaults to 60 seconds.
   */
  elicitationTimeoutMs?: number;
}

export interface BuiltMcpServer {
  server: McpServer;
  taskStore: InMemoryTaskStore;
}

export function createMcpServer(deps: McpServerDeps): BuiltMcpServer {
  const taskStore = deps.taskStore ?? new InMemoryTaskStore();

  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
        },
      },
      instructions:
        'Muca is an ops copilot for small teams. It triages deployment and CI ' +
        'failures, correlates them with open issues, and — only with explicit ' +
        'user approval — opens a branch and a pull request. ' +
        'Tools marked readOnlyHint are safe to call. Tools marked destructiveHint ' +
        'require explicit user confirmation before they run; the server asks for ' +
        'that confirmation with an elicitation request. ' +
        'The diagnose_incident tool is long-running: it returns a task handle you ' +
        'can poll with tasks/get.',
      taskStore,
    },
  );

  // The elicitation gate is built from *this* server, so the approval
  // request goes to the client that owns this session.
  const elicitationTimeoutMs = deps.elicitationTimeoutMs ?? 60_000;
  const approvalGate: ApprovalGate = new ElicitationApprovalGate(
    createElicitationSource(server.server, { timeoutMs: elicitationTimeoutMs }),
    undefined,
    elicitationTimeoutMs,
  );

  for (const tool of deps.registry.list()) {
    registerToolWithSdk(server, tool, approvalGate);
  }

  registerTaskTools(server, {
    adapters: deps.adapters,
    runner: deps.taskRunner,
  });

  return { server, taskStore };
}
function registerToolWithSdk(
  server: McpServer,
  tool: MucaTool,
  approvalGate: ApprovalGate,
): void {
  const annotations: ToolAnnotations = {
    readOnlyHint: !tool.destructive,
    destructiveHint: tool.destructive,
    idempotentHint: !tool.destructive,
    openWorldHint: false,
    title: tool.title,
  };

  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema.shape,
      annotations,
    },
    async (args: Record<string, unknown>) => {
      try {
        // The SDK already validated the arguments against the schema, but
        // re-validating here keeps the tool contract self-contained.
        const parsed = tool.inputSchema.safeParse(args);
        if (!parsed.success) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid arguments for ${tool.name}`,
              },
            ],
            isError: true,
          };
        }

        // A destructive tool needs the client's approval first. The
        // protocol-native way to ask is an elicitation request.
        if (tool.destructive) {
          const approved = await approvalGate.request({
            approval: {
              toolName: tool.name,
              title: tool.title,
              message: describeCall(tool.title, parsed.data),
              arguments: parsed.data as Record<string, unknown>,
            },
            requestId: `mcp:${tool.name}:${Date.now()}`,
            // If the client cannot be asked, the tool does not run.
            fallback: async () => false,
          });

          if (!approved) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `The user declined to run ${tool.name}. Nothing was changed.`,
                },
              ],
              isError: true,
            };
          }
        }

        const result = await tool.handler(parsed.data);
        return {
          content: [{ type: 'text' as const, text: result.summary }],
          ...(result.data !== undefined
            ? { structuredContent: result.data as Record<string, unknown> }
            : {}),
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown tool failure';
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

/** A short, human-readable description of a call. */
function describeCall(title: string, args: unknown): string {
  if (!args || typeof args !== 'object') return title;
  const rendered = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
  return rendered ? `${title} (${rendered})` : title;
}
