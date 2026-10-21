import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import { ToolRegistry, type MucaTool } from '../tools/registry.js';

export const SERVER_NAME = 'muca-mcp';
export const SERVER_VERSION = '0.1.0';

/**
 * Builds the MCP server and registers every tool from the registry.
 *
 * The MCP server owns *protocol* concerns only: schema publication and
 * argument validation. Actual behaviour lives in the tool handlers, so the
 * same tool implementation can be reused by a non-MCP caller if needed.
 */
export function createMcpServer(registry: ToolRegistry): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Muca exposes practical tools for the Alexa+ hackathon demo. ' +
        'Tools marked readOnlyHint are safe to call. Tools marked destructiveHint ' +
        'require explicit user confirmation before they run.',
    },
  );

  for (const tool of registry.list()) {
    registerToolWithSdk(server, tool);
  }

  return server;
}

function registerToolWithSdk(server: McpServer, tool: MucaTool): void {
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
