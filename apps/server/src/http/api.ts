import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { Agent, type AgentEvent } from '../ai/agent.js';
import type { AIProvider, ProviderMessage } from '../ai/provider.js';
import {
  HttpApprovalGate,
  noopApprovalAudit,
  type ApprovalAudit,
} from '../ai/approval-gate.js';
import type { ToolRegistry } from '../tools/registry.js';
import { SERVER_NAME, SERVER_VERSION } from '../mcp/server.js';
import type { RunHistoryStore, RunRecord } from '../store/run-history.js';
import type { PendingApprovalRegistry } from '../store/pending-approvals.js';
import { isTerminalStatus, type TaskStatus } from '../mcp/tasks.js';
import { randomUUID } from 'node:crypto';

export const API_PREFIX = '/api/v1';

/**
 * The REST surface used by the web client.
 *
 * Everything the frontend needs lives under `/api/v1`:
 *   GET  /api/v1/health          — liveness + configuration summary
 *   GET  /api/v1/tools           — the MCP tool catalogue
 *   POST /api/v1/chat            — run the agent
 *   GET  /api/v1/runs            — the run history
 *   GET  /api/v1/runs/:runId     — one run
 *   GET  /api/v1/tasks/:taskId   — the status of a long-running task
 *   GET  /api/v1/tasks           — the list of long-running tasks
 */
export function createApiRouter(deps: {
  registry: ToolRegistry;
  provider: AIProvider | null;
  systemPrompt: string;
  protocolVersion: string;
  mcpUrl: string;
  /**
   * The run history store. Optional: without it the run routes report an
   * empty history and `/chat` does not persist anything. The production
   * wiring always supplies one.
   */
  runHistory?: RunHistoryStore;
  /**
   * The parked approvals.
   *
   * The browser cannot answer an elicitation, so a destructive call parks
   * the run and the client sends the call id back. The model produces a
   * fresh call id on the next turn, so the registry maps the approved call
   * id back to the tool it referred to.
   */
  pendingApprovals?: PendingApprovalRegistry;
  /** Reads a task by id. Returns null when it is unknown. */
  getTask?: (taskId: string) => Promise<TaskSnapshotLike | null>;
  /** Lists the known tasks. */
  listTasks?: () => Promise<TaskSnapshotLike[]>;
  /** The audit sink the approval decisions are written to. */
  approvalAudit?: ApprovalAudit;
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

    // The HTTP approval path: the client sends the call ids it approved.
    // The gate parks the run until one of them shows up.
    //
    // The model produces a fresh call id on every turn, so the approved
    // call id is looked up in the registry to find the tool it referred
    // to. That tool name is then approved for the next call.
    const approvedCallIds = parsed.data.approvedCallIds;
    const approvedToolNames = approvedCallIds
      .map((callId) => deps.pendingApprovals?.get(callId)?.toolName)
      .filter((name): name is string => Boolean(name));

    const gate = new HttpApprovalGate(
      approvedCallIds,
      approvedToolNames,
      deps.approvalAudit ?? noopApprovalAudit,
    );

    const runId = `run_${randomUUID()}`;
    const startedAt = new Date().toISOString();

    try {
      const result = await agent.run({
        history,
        userMessage: parsed.data.message,
        approvalGate: gate,
        approvedCallIds,
      });

      // Remember what the run is waiting for, so the next turn can be
      // matched to it.
      if (result.pendingCall) {
        deps.pendingApprovals?.add({
          callId: result.pendingCall.callId,
          toolName: result.pendingCall.name,
          arguments: result.pendingCall.arguments,
          at: startedAt,
        });
      } else {
        // The run is no longer waiting for anything: clear the parked
        // approvals it consumed.
        for (const callId of approvedCallIds) {
          deps.pendingApprovals?.remove(callId);
        }
      }

      const record = buildRunRecord({
        runId,
        startedAt,
        userMessage: parsed.data.message,
        result,
      });
      await deps.runHistory?.save(record);

      res.json({
        ...serializeAgentResult(result),
        runId: record.id,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Agent run failed';
      await deps.runHistory?.save({
        id: runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        userMessage: parsed.data.message,
        text: '',
        outcome: 'error',
        toolCalls: [],
        approvals: [],
        taskId: null,
        error: message,
      });
      res.status(500).json({ error: message });
    }
  });

  /* ------------------------------------------------------------------ */
  /* Run history                                                         */
  /* ------------------------------------------------------------------ */

  router.get('/runs', (req: Request, res: Response) => {
    const limit = clampLimit(req.query.limit);
    res.json({ runs: deps.runHistory?.list(limit) ?? [] });
  });

  router.get('/runs/:runId', (req: Request, res: Response) => {
    const runId = String(req.params.runId);
    const run = deps.runHistory?.get(runId) ?? null;
    if (!run) {
      res.status(404).json({ error: `No run with id ${runId}.` });
      return;
    }
    res.json({ run });
  });

  /* ------------------------------------------------------------------ */
  /* Long-running tasks                                                  */
  /* ------------------------------------------------------------------ */

  router.get('/tasks', async (_req: Request, res: Response) => {
    const tasks = (await deps.listTasks?.()) ?? [];
    res.json({ tasks });
  });

  router.get('/tasks/:taskId', async (req: Request, res: Response) => {
    const taskId = String(req.params.taskId);
    const task = (await deps.getTask?.(taskId)) ?? null;
    if (!task) {
      res.status(404).json({ error: `No task with id ${taskId}.` });
      return;
    }
    res.json({ task });
  });

  return router;
}

/** The task shape the REST API returns. */
export interface TaskSnapshotLike {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  statusMessage?: string;
  result?: unknown;
  error?: string;
}

function clampLimit(raw: unknown): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(Math.max(Math.trunc(parsed), 1), 100);
}

/**
 * Turns the agent result into the persisted run record.
 *
 * The tool calls and the approval decisions are read off the event list,
 * which is the single source of truth for what happened.
 */
export function buildRunRecord(input: {
  runId: string;
  startedAt: string;
  userMessage: string;
  result: {
    text: string;
    events: AgentEvent[];
    awaitingConfirmation: boolean;
  };
}): RunRecord {
  const toolCalls: RunRecord['toolCalls'] = [];
  const approvals: RunRecord['approvals'] = [];
  const errors: string[] = [];

  for (const event of input.result.events) {
    switch (event.type) {
      case 'tool_call':
        toolCalls.push({
          id: event.id,
          name: event.name,
          arguments: event.arguments,
          at: input.startedAt,
        });
        break;
      case 'tool_result': {
        const existing = toolCalls.find((call) => call.id === event.id);
        if (existing) {
          existing.summary = event.result.summary;
        }
        break;
      }
      case 'approval_decision':
        approvals.push({
          requestId: event.callId,
          toolName: event.name,
          decision: event.approved ? 'approved' : 'rejected',
          source: event.source,
          at: input.startedAt,
        });
        break;
      case 'error':
        errors.push(event.message);
        break;
      default:
        break;
    }
  }

  return {
    id: input.runId,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    userMessage: input.userMessage,
    text: input.result.text,
    outcome: input.result.awaitingConfirmation
      ? 'awaiting_approval'
      : errors.length > 0
        ? 'error'
        : 'completed',
    toolCalls,
    approvals,
    taskId: null,
    error: errors.length > 0 ? errors.join('; ') : null,
  };
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
        case 'approval_decision':
          return {
            type: 'approval_decision',
            id: event.callId,
            name: event.name,
            approved: event.approved,
            source: event.source,
          };
        case 'error':
          return { type: 'error', message: event.message };
        default:
          return { type: 'error', message: 'Unknown event' };
      }
    }),
  };
}

export { isTerminalStatus };
