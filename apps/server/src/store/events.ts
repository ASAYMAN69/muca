import type { DatabaseSync } from 'node:sqlite';

import { transaction } from './db.js';

/** One durable event. */
export interface StoredEvent {
  sessionId: string;
  seq: number;
  runId: string | null;
  type: string;
  /** The frame payload, as JSON. */
  data: unknown;
  createdAt: string;
}

interface EventRow {
  session_id: string;
  seq: number;
  run_id: string | null;
  type: string;
  data: string;
  created_at: string;
}

/**
 * The durable event log.
 *
 * `events` is the replay source: when a client reconnects and the
 * in-memory ring buffer no longer holds the frames it missed, they come
 * from here. The primary key `(session_id, seq)` is what makes the
 * sequence per session and unique.
 *
 * The database is only ever written by the **flush** at the end of a run
 * (§6 of the protocol): the live frames live in memory while the run is
 * going, and land here in one transaction when it finishes.
 */
export class EventStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Appends one event. */
  append(event: {
    sessionId: string;
    seq: number;
    runId?: string | null;
    type: string;
    data: unknown;
    createdAt?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO events (session_id, seq, run_id, type, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO NOTHING`,
      )
      .run(
        event.sessionId,
        event.seq,
        event.runId ?? null,
        event.type,
        JSON.stringify(event.data ?? {}),
        event.createdAt ?? new Date().toISOString(),
      );
  }

  /**
   * Appends many events in one transaction.
   *
   * The flush writes a whole run at once, so it is one transaction: either
   * the run is in the log or it is not, never half of it.
   */
  appendMany(events: StoredEvent[]): void {
    if (events.length === 0) return;
    transaction(this.db, () => {
      const statement = this.db.prepare(
        `INSERT INTO events (session_id, seq, run_id, type, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, seq) DO NOTHING`,
      );
      for (const event of events) {
        statement.run(
          event.sessionId,
          event.seq,
          event.runId,
          event.type,
          JSON.stringify(event.data ?? {}),
          event.createdAt,
        );
      }
    });
  }

  /** The events of a session in a sequence range, oldest first. */
  readRange(sessionId: string, fromSeq: number, toSeq: number): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE session_id = ? AND seq >= ? AND seq <= ?
         ORDER BY seq ASC`,
      )
      .all(sessionId, fromSeq, toSeq) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** Every event of a session from a sequence onwards, oldest first. */
  readFrom(sessionId: string, fromSeq: number, limit = 5000): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE session_id = ? AND seq >= ?
         ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, fromSeq, limit) as unknown as EventRow[];
    return rows.map(toEvent);
  }

  /** The highest sequence number stored for a session. */
  maxSeq(sessionId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS max FROM events WHERE session_id = ?')
      .get(sessionId) as { max: number | null } | undefined;
    return row?.max ?? 0;
  }

  /** How many events of a session are stored from a sequence onwards. */
  countFrom(sessionId: string, fromSeq: number): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND seq >= ?',
      )
      .get(sessionId, fromSeq) as { count: number } | undefined;
    return row?.count ?? 0;
  }
}

function toEvent(row: EventRow): StoredEvent {
  let data: unknown = {};
  try {
    data = JSON.parse(row.data) as unknown;
  } catch {
    data = {};
  }
  return {
    sessionId: row.session_id,
    seq: row.seq,
    runId: row.run_id,
    type: row.type,
    data,
    createdAt: row.created_at,
  };
}
