import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** What the agent is waiting for. */
export type RequestKind = 'permission' | 'clarification';

/** What happened to a request. */
export type RequestStatus = 'pending' | 'answered' | 'resolved';

/** One outstanding request. */
export interface StoredRequest {
  id: string;
  sessionId: string;
  runId: string | null;
  kind: RequestKind;
  question: string;
  /** The choices the agent offered, when it offered any. */
  options: string[] | null;
  status: RequestStatus;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
}

interface RequestRow {
  id: string;
  session_id: string;
  run_id: string | null;
  kind: string;
  question: string;
  options: string | null;
  status: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

/**
 * The requests the agent is waiting on.
 *
 * A request is a question the agent asked, or a permission it needs. The
 * user answers whenever they are next in the UI, so the request outlives
 * the HTTP request that created it.
 */
export class RequestStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Records a request the agent is waiting on. */
  create(input: {
    id?: string;
    sessionId: string;
    runId?: string | null;
    kind: RequestKind;
    question: string;
    options?: string[] | null;
  }): StoredRequest {
    const id = input.id ?? `req_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const options = input.options?.length ? JSON.stringify(input.options) : null;

    this.db
      .prepare(
        `INSERT INTO requests (id, session_id, run_id, kind, question, options,
                               status, answer, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run(
        id,
        input.sessionId,
        input.runId ?? null,
        input.kind,
        input.question,
        options,
        createdAt,
      );

    return {
      id,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      kind: input.kind,
      question: input.question,
      options: input.options ?? null,
      status: 'pending',
      answer: null,
      createdAt,
      answeredAt: null,
    };
  }

  /** Records the answer to a request. */
  answer(input: {
    id: string;
    answer: string;
    status?: RequestStatus;
  }): void {
    this.db
      .prepare('UPDATE requests SET answer = ?, status = ?, answered_at = ? WHERE id = ?')
      .run(
        input.answer,
        input.status ?? 'answered',
        new Date().toISOString(),
        input.id,
      );
  }

  /** Reads one request. */
  get(id: string): StoredRequest | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined;
    return row ? toRequest(row) : null;
  }

  /** The requests of a session that are still waiting. */
  listPending(sessionId: string): StoredRequest[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM requests WHERE session_id = ? AND status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as unknown as RequestRow[];
    return rows.map(toRequest);
  }

  /** The requests of a session, newest first. */
  listForSession(sessionId: string, limit = 50): StoredRequest[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM requests WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(sessionId, limit) as unknown as RequestRow[];
    return rows.map(toRequest);
  }
}

function toRequest(row: RequestRow): StoredRequest {
  let options: string[] | null = null;
  if (row.options) {
    try {
      const parsed: unknown = JSON.parse(row.options);
      options = Array.isArray(parsed)
        ? parsed.filter((o): o is string => typeof o === 'string')
        : null;
    } catch {
      options = null;
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    kind: row.kind as RequestKind,
    question: row.question,
    options,
    status: row.status as RequestStatus,
    answer: row.answer,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}
