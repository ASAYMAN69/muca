import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { Agent, type AgentEvent } from '../ai/agent.js';
import type { AIProvider, ProviderMessage } from '../ai/provider.js';
import {
  HttpApprovalGate,
  noopApprovalAudit,
  type ApprovalAudit,
  type ApprovedAction,
} from '../ai/approval-gate.js';
import type { ToolRegistry } from '../tools/registry.js';
import {
  buildCatalogue,
  toHealthJson,
  toJson,
} from '../tools/catalogue.js';
import { SERVER_NAME, SERVER_VERSION } from '../mcp/server.js';
import type {
  PendingApproval,
  PendingApprovalRegistry,
} from '../store/pending-approvals.js';
import type { MucaStore } from '../store/index.js';
import type { LiveService } from '../live/service.js';
import { createSessionsRouter } from './sessions-api.js';
import { createPoliciesRouter } from './policies-api.js';
import type { AiState } from '../ai/ai-state.js';
import type { GatewayDecision } from '../ai/gateway.js';
import type { ProbeResult } from '../ai/probe.js';
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
 *   GET  /api/v1/tasks/:taskId   — the status of a long-running task
 *   GET  /api/v1/tasks           — the list of long-running tasks
 *
 * The session and policy routes are mounted beside them when a database
 * is wired up. They are **additive**: nothing above changes shape.
 */
export function createApiRouter(deps: {
  registry: ToolRegistry;
  provider: AIProvider | null;
  systemPrompt: string;
  protocolVersion: string;
  mcpUrl: string;
  /**
   * The database.
   *
   * Optional: without it there are no session or policy routes. The
   * production wiring always supplies one.
   */
  store?: MucaStore;
  /**
   * The live service.
   *
   * Optional: without it `/chat` behaves exactly as it always has — a
   * request/response run with no streaming. With it, a run that names a
   * session also streams to that session's socket.
   */
  live?: LiveService;
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
  /**
   * The gateway's state.
   *
   * `enabled` and `provider` are reported exactly as the web client
   * expects them; `mode`, `selectedAt` and `probes` are additive.
   */
  ai?: AiState;
  /**
   * Re-runs the provider probes.
   *
   * A diagnostic, not a hot-swap: the provider in use does not change.
   */
  probe?: () => Promise<{
    probes: ProbeResult[];
    applied: false;
    decision: GatewayDecision;
  }>;
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
    /**
     * The session the run belongs to.
     *
     * Optional and additive: a request without it behaves exactly as it
     * always has. With it, the run is streamed to that session's socket
     * and it survives a restart.
     */
    sessionId: z.string().max(120).optional(),
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
        // `enabled` and `provider` are exactly what the web client reads.
        enabled: deps.provider !== null,
        provider: deps.provider?.name ?? null,
        // Additive: the gateway's detail.
        ...(deps.ai
          ? {
              model: deps.ai.model,
              mode: deps.ai.mode,
              selectedAt: deps.ai.selectedAt,
              probes: deps.ai.probes,
            }
          : {}),
      },
      // The same catalogue the MCP server advertises, so the two can
      // never disagree about Muca's tool surface.
      tools: catalogue().map(toHealthJson),
    });
  });

  router.get('/tools', (_req: Request, res: Response) => {
    res.json({
      tools: catalogue().map(toJson),
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

    // The live path: the run is streamed to the session's socket, and it
    // keeps going in the background when it parks on a permission or a
    // question. The response comes back when the run reaches a decision
    // point, so the old client and the new one agree.
    const sessionId = deps.live?.resolveSession(parsed.data.sessionId) ?? null;
    if (sessionId && deps.live) {
      const run = deps.live.start({
        sessionId,
        message: parsed.data.message,
        history: historyForSession(deps.store, sessionId, history),
      });

      if (run) {
        await run.whenParked();

        const pendingCall = run.pendingPermission();
        res.json({
          // The same shape the request/response path returns: the
          // model's answer, the events, and the pending permission.
          text: run.finalText(),
          awaitingConfirmation: pendingCall !== null,
          pendingCall,
          events: serializeAgentResult({
            text: run.finalText(),
            events: run.agentEvents(),
            awaitingConfirmation: pendingCall !== null,
            pendingCall: null,
          }).events,
          runId: run.runId,
          // Additive: the run is live, and it is still going.
          live: true,
        });
        return;
      }
    }

    // The HTTP approval path: the client sends the call ids it approved.
    // The gate parks the run until one of them shows up.
    //
    // The model produces a fresh call id on every turn, so the approved
    // call id is looked up in the registry to recover the *parked action*
    // — the tool **and** the arguments the user actually saw and
    // approved. The approval then authorises only a call that makes
    // exactly that action; a call with different arguments is a different
    // action and parks again for a fresh confirmation.
    //
    // The registry is the authority: a call id the server never issued
    // resolves to nothing, so a client cannot invent an approval.
    const approvedCallIds = parsed.data.approvedCallIds;
    const approvedActions: ApprovedAction[] = [
      // De-duplicate: a client that sends the same id twice must not get
      // two approvals out of it. One id is one approval, and it can
      // authorise at most one action.
      ...new Set(approvedCallIds),
    ]
      .map((callId) => deps.pendingApprovals?.get(callId))
      .filter((parked): parked is PendingApproval => Boolean(parked))
      .map((parked) => ({
        callId: parked.callId,
        toolName: parked.toolName,
        arguments: parked.arguments,
      }));

    const gate = new HttpApprovalGate(
      approvedActions,
      deps.approvalAudit ?? noopApprovalAudit,
      // Resolve Zod defaults on both sides before comparing, so a call
      // that omits a defaulted field and a parked call that spelled it
      // out are the same action.
      (toolName) => {
        const tool = deps.registry.get(toolName);
        if (!tool) return undefined;
        return (args) => tool.inputSchema.parse(args) as Record<string, unknown>;
      },
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
      }

      // Retire the approvals this run *consumed*, whatever the run did
      // afterwards.
      //
      // An approval is spent the moment it has been resolved into an
      // action and the run has acted on it. The registry is the authority
      // on which call ids the server issued, so a stale entry there is a
      // standing authorisation: a client that replayed the id would get it
      // resolved into a fresh action and the action would run again.
      //
      // The retirement must happen whether the run completed, parked on a
      // *different* action, or errored — so it is done here, after the
      // run, and not in an `else` branch.
      for (const callId of approvedCallIds) {
        deps.pendingApprovals?.remove(callId);
      }

      res.json({
        ...serializeAgentResult(result),
        runId,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Agent run failed';
      res.status(500).json({ error: message });
    }
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

  /* ------------------------------------------------------------------ */
  /* The AI gateway                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Re-runs the provider probes.
   *
   * A **diagnostic**, not a hot-swap: the provider this process is using
   * does not change. `applied: false` says so explicitly.
   */
  router.post('/ai/probe', async (_req: Request, res: Response) => {
    if (!deps.probe) {
      res.status(501).json({ error: 'The probe endpoint is not configured.' });
      return;
    }

    try {
      const result = await deps.probe();
      res.json({
        // The probes that just ran.
        probes: result.probes,
        // What the gateway *would* pick, given these results.
        wouldSelect: result.decision.selected,
        // The provider in use for this process — unchanged.
        provider: deps.provider?.name ?? null,
        // Always false: this endpoint does not change the live provider.
        applied: false,
        message:
          'These are fresh probe results. The provider in use for this process is unchanged.',
      });
    } catch (error) {
      res.status(500).json({
        error:
          error instanceof Error ? error.message : 'The probe failed unexpectedly.',
      });
    }
  });

  /* ------------------------------------------------------------------ */
  /* Sessions and policies                                               */
  /* ------------------------------------------------------------------ */

  // They need a database. Without one the routes are simply not there,
  // which is what the tests that do not use a database expect.
  if (deps.store) {
    router.use(createSessionsRouter({ store: deps.store, registry: deps.registry }));
    router.use(createPoliciesRouter({ store: deps.store }));
  }

  /**
   * The full tool catalogue.
   *
   * Built from the same declaration the MCP server registers from, so
   * `GET /api/v1/tools`, `GET /api/v1/health` and MCP `tools/list` always
   * describe the same set.
   */
  function catalogue() {
    return buildCatalogue(deps.registry.list());
  }

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

/**
 * The conversation of a session.
 *
 * The database is the source of truth for a session: the messages are
 * what the user has already said and what the agent has already
 * answered. The client-supplied history is only used when the session
 * has nothing stored yet.
 */
function historyForSession(
  store: MucaStore | undefined,
  sessionId: string,
  fallback: ProviderMessage[],
): ProviderMessage[] {
  if (!store) return fallback;

  const stored = store.messages
    .list(sessionId)
    .filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    )
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    }));

  return stored.length > 0 ? stored : fallback;
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
        case 'text_delta':
          return { type: 'text_delta', text: event.text };
        case 'thinking':
          return { type: 'thinking', text: event.text };
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
