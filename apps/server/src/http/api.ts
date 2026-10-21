import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { Agent, type AgentEvent } from '../ai/agent.js';
import type { AIProvider, ProviderMessage } from '../ai/provider.js';
import type { ToolRegistry } from '../tools/registry.js';
import { SERVER_NAME, SERVER_VERSION } from '../mcp/server.js';

export const API_PREFIX = '/api/v1';

/**
 * REST surface used by the web client.
 *
 * Everything the frontend needs lives under `/api/v1`:
 *   GET  /api/v1/health          — liveness + configuration summary
 *   GET  /api/v1/tools           — the MCP tool catalogue
 *   POST /api/v1/chat            — run the agent
 *   POST /api/v1/chat/confirm    — approve a pending destructive tool call
 */
export function createApiRouter(deps: {
  registry: ToolRegistry;
  provider: AIProvider | null;
  systemPrompt: string;
  protocolVersion: string;
  mcpUrl: string;
}): Router {
  const router = Router();

  const chatRequestSchema = z.object({
    message: z.string().min(1, 'message must not be empty').max(8000),
    history: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string(),
        }),
      )
      .default([]),
    /** Tool call ids the user has approved in this turn. */
    approvedCallIds: z.array(z.string()).default([]),
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      mcp: {
        protocolVersion: deps.protocolVersion,
        url: deps.mcpUrl,
      },
      ai: {
        enabled: deps.provider !== null,
        provider: deps.provider?.name ?? null,
      },
      tools: deps.registry.list().map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        destructive: tool.destructive,
      })),
    });
  });

  router.get('/tools', (_req: Request, res: Response) => {
    res.json({
      tools: deps.registry.list().map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        destructive: tool.destructive,
        inputSchema: tool.inputSchema.shape,
      })),
    });
  });

  router.post('/chat', async (req: Request, res: Response) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid request body',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    if (!deps.provider) {
      res.status(503).json({
        error:
          'The AI provider is not configured. Set OPENAI_API_KEY in .env and restart the server.',
      });
      return;
    }

    const agent = new Agent({
      provider: deps.provider,
      registry: deps.registry,
      systemPrompt: deps.systemPrompt,
    });

    const history: ProviderMessage[] = parsed.data.history.map((turn) => ({
      role: turn.role,
      content: turn.content,
    }));

    try {
      const result = await agent.run({
        history,
        userMessage: parsed.data.message,
        approvedCallIds: parsed.data.approvedCallIds,
      });
      res.json(serializeAgentResult(result));
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Agent run failed',
      });
    }
  });

  return router;
}

export function serializeAgentResult(result: {
  text: string;
  events: AgentEvent[];
  awaitingConfirmation: boolean;
  pendingCall: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    message: string;
  } | null;
}) {
  return {
    text: result.text,
    awaitingConfirmation: result.awaitingConfirmation,
    pendingCall: result.pendingCall,
    events: result.events.map((event) => {
      switch (event.type) {
        case 'text':
          return { type: 'text', text: event.text };
        case 'tool_call':
          return {
            type: 'tool_call',
            id: event.id,
            name: event.name,
            arguments: event.arguments,
          };
        case 'tool_result':
          return {
            type: 'tool_result',
            id: event.id,
            name: event.name,
            summary: event.result.summary,
            data: event.result.data ?? null,
          };
        case 'confirmation_required':
          return {
            type: 'confirmation_required',
            id: event.callId,
            name: event.name,
            arguments: event.arguments,
            message: event.message,
          };
        case 'error':
          return { type: 'error', message: event.message };
        default:
          return { type: 'error', message: 'Unknown event' };
      }
    }),
  };
}
