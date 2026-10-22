import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** How a run ended. */
export type RunOutcome = 'completed' | 'awaiting_approval' | 'error' | 'cancelled';

/** One persisted run. */
export interface StoredRun {
  id: string;
  sessionId: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: RunOutcome | null;
  error: string | null;
  toolCallCount: number;
  approvalCount: number;
  taskId: string | null;
}

interface RunRow {
  id: string;
  session_id: string;
  started_at: string;
  finished_at: string | null;
  outcome: string | null;
  error: string | null;
  tool_call_count: number | null;
  approval_count: number | null;
  task_id: string | null;
}

/**
 * The runs.
 *
 * A run row is written when the run finishes. It is the summary the
 * session view shows; the full story is in the event log.
 */
export class RunStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Records the start of a run. */
  start(input: {
    id?: string;
    sessionId: string;
    startedAt?: string;
  }): StoredRun {
    const run: StoredRun = {
      id: input.id ?? `run_${randomUUID()}`,
      sessionId: input.sessionId,
      startedAt: input.startedAt ?? new Date().toISOString(),
      finishedAt: null,
      outcome: null,
      error: null,
      toolCallCount: 0,
      approvalCount: 0,
      taskId: null,
    };

    this.db
      .prepare(
        `INSERT INTO runs (id, session_id, started_at, finished_at, outcome, error,
                           tool_call_count, approval_count, task_id)
         VALUES (?, ?, ?, NULL, NULL, NULL, 0, 0, NULL)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(run.id, run.sessionId, run.startedAt);

    return run;
  }

  /** Records how a run ended. */
  finish(input: {
    id: string;
    outcome: RunOutcome;
    error?: string | null;
    toolCallCount?: number;
    approvalCount?: number;
    taskId?: string | null;
    finishedAt?: string;
  }): void {
    this.db
      .prepare(
        `UPDATE runs SET finished_at = ?, outcome = ?, error = ?,
                         tool_call_count = ?, approval_count = ?, task_id = ?
         WHERE id = ?`,
      )
      .run(
        input.finishedAt ?? new Date().toISOString(),
        input.outcome,
        input.error ?? null,
        input.toolCallCount ?? 0,
        input.approvalCount ?? 0,
        input.taskId ?? null,
        input.id,
      );
  }

  /** Reads one run. */
  get(id: string): StoredRun | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      | RunRow
      | undefined;
    return row ? toRun(row) : null;
  }

  /** The runs of a session, newest first. */
  listForSession(sessionId: string, limit = 50): StoredRun[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT ?',
      )
      .all(sessionId, limit) as unknown as RunRow[];
    return rows.map(toRun);
  }
}

function toRun(row: RunRow): StoredRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: (row.outcome as RunOutcome | null) ?? null,
    error: row.error,
    toolCallCount: row.tool_call_count ?? 0,
    approvalCount: row.approval_count ?? 0,
    taskId: row.task_id,
  };
}
