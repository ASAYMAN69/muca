import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import type { MucaStore } from '../store/index.js';
import type { ToolRegistry } from '../tools/registry.js';

/**
 * The session routes.
 *
 * Everything here is **additive**: the routes the web client already
 * used keep their shape, and these are new ones beside them.
 *
 *   GET    /api/v1/sessions               — the sidebar
 *   POST   /api/v1/sessions               — a new session
 *   GET    /api/v1/sessions/:id           — one session, in full
 *   PATCH  /api/v1/sessions/:id           — rename, archive
 *   GET    /api/v1/sessions/:id/events    — the event log, for a replay
 */
export function createSessionsRouter(deps: {
  store: MucaStore;
  /** The tool registry, so a waiting permission can name its tool. */
  registry: ToolRegistry;
}): Router {
  const router = Router();

  const createSchema = z.object({
    title: z.string().max(200).default(''),
  });

  const patchSchema = z.object({
    title: z.string().max(200).optional(),
    archived: z.boolean().optional(),
  });

  router.get('/sessions', (_req: Request, res: Response) => {
    const sessions = deps.store.sessions.list().map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      archived: session.archived,
      waiting: waitingCount(deps.store, session.id),
      waitingCount: waitingCount(deps.store, session.id),
      active: deps.store.runs
        .listForSession(session.id, 1)
        .some((run) => run.finishedAt === null),
    }));

    res.json({ sessions });
  });

  router.post('/sessions', (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    const session = deps.store.sessions.create({ title: parsed.data.title });
    res.status(201).json({ session: sessionDetail(deps, session.id) });
  });

  router.get('/sessions/:id', (req: Request, res: Response) => {
    const sessionId = String(req.params.id);
    const session = deps.store.sessions.get(sessionId);

    if (!session) {
      res.status(404).json({ error: `No session with id ${sessionId}.` });
      return;
    }

    res.json({ session: sessionDetail(deps, sessionId) });
  });

  router.patch('/sessions/:id', (req: Request, res: Response) => {
    const sessionId = String(req.params.id);
    const parsed = patchSchema.safeParse(req.body ?? {});

    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }

    const session = deps.store.sessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: `No session with id ${sessionId}.` });
      return;
    }

    if (parsed.data.title !== undefined) {
      deps.store.sessions.rename(sessionId, parsed.data.title);
    }
    if (parsed.data.archived !== undefined) {
      deps.store.sessions.setArchived(sessionId, parsed.data.archived);
    }

    res.json({ session: sessionDetail(deps, sessionId) });
  });

  /**
   * The event log of a session.
   *
   * It is the same log the socket replays from, so a client that has
   * missed frames can rebuild the run over REST.
   */
  router.get('/sessions/:id/events', (req: Request, res: Response) => {
    const sessionId = String(req.params.id);

    const fromSeqRaw = req.query.fromSeq;
    const parsedSeq = Number(fromSeqRaw);
    const fromSeq =
      fromSeqRaw !== undefined && Number.isFinite(parsedSeq)
        ? Math.max(0, Math.trunc(parsedSeq))
        : 0;

    const events = deps.store.events.readFrom(sessionId, fromSeq).map((event) => ({
      seq: event.seq,
      sessionId: event.sessionId,
      runId: event.runId,
      type: event.type,
      data: event.data,
      ts: event.createdAt,
    }));

    res.json({
      events,
      nextSeq: deps.store.events.maxSeq(sessionId) + 1,
    });
  });

  return router;
}

/** How many requests a session is waiting for. */
function waitingCount(store: MucaStore, sessionId: string): number {
  return (
    store.approvals.listPending(sessionId).length +
    store.requests
      .listPending(sessionId)
      .filter((request) => request.kind === 'clarification').length
  );
}

/** One session, with everything it holds. */
function sessionDetail(
  deps: { store: MucaStore; registry: ToolRegistry },
  sessionId: string,
): Record<string, unknown> {
  const store = deps.store;
  const session = store.sessions.get(sessionId);

  const messages = store.messages.list(sessionId).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  }));

  const runs = store.runs.listForSession(sessionId).map((run) => ({
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    toolCallCount: run.toolCallCount,
    approvalCount: run.approvalCount,
    taskId: run.taskId,
    error: run.error,
  }));

  const waiting: Array<Record<string, unknown>> = [];

  for (const approval of store.approvals.listPending(sessionId)) {
    const tool = deps.registry.get(approval.toolName);
    waiting.push({
      id: approval.requestId ?? approval.id,
      kind: 'permission',
      tool: approval.toolName,
      title: tool?.title ?? approval.toolName,
      createdAt: approval.createdAt,
    });
  }

  for (const request of store.requests.listPending(sessionId)) {
    if (request.kind !== 'clarification') continue;
    waiting.push({
      id: request.id,
      kind: 'clarification',
      question: request.question,
      options: request.options ?? undefined,
      createdAt: request.createdAt,
    });
  }

  return {
    id: sessionId,
    title: session?.title ?? '',
    createdAt: session?.createdAt ?? null,
    updatedAt: session?.updatedAt ?? null,
    archived: session?.archived ?? false,
    messages,
    runs,
    waiting,
  };
}
