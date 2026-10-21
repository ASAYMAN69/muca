import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface DiscoveredTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpProbeResult {
  connected: boolean;
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  tools: DiscoveredTool[];
  error?: string;
}

/**
 * A real MCP client, used to verify the server end to end.
 *
 * The integration tests and the `/api/v1/mcp/inspect` endpoint both go
 * through this, which means the server is always exercised over the actual
 * Streamable HTTP transport rather than by calling handlers directly.
 */
export async function probeMcpServer(
  url: string,
  clientInfo: { name: string; version: string } = {
    name: 'muca-self-check',
    version: '0.1.0',
  },
): Promise<McpProbeResult> {
  const client = new Client(clientInfo, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url));

  try {
    await client.connect(transport);

    const serverVersion = client.getServerVersion();
    const list = await client.listTools();

    await client.close();

    return {
      connected: true,
      protocolVersion: client.getServerVersion()
        ? (client as unknown as { _serverCapabilities?: unknown }) &&
          JSON.stringify(client.getServerCapabilities?.() ?? {})
        : 'unknown',
      serverInfo: {
        name: serverVersion?.name ?? 'unknown',
        version: serverVersion?.version ?? 'unknown',
      },
      tools: list.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
      })),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    return {
      connected: false,
      protocolVersion: 'unknown',
      serverInfo: { name: 'unknown', version: 'unknown' },
      tools: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
