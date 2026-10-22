import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { transaction } from './db.js';

/** A session in the sidebar. */
export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

/** The row as it is stored. */
interface SessionRow {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived: number;
}

/**
 * The sessions.
 *
 * A session is the unit the live protocol is organised around: one
 * socket, one sequence counter, one event log.
 */
export class SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Creates a session and returns it. */
  create(input: { id?: string; title?: string } = {}): Session {
    const now = new Date().toISOString();
    const session: Session = {
      id: input.id ?? `ses_${randomUUID()}`,
      title: input.title ?? '',
      createdAt: now,
      updatedAt: now,
      archived: false,
    };

    this.db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, updated_at, archived)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(session.id, session.title, session.createdAt, session.updatedAt);

    return session;
  }

  /** Reads one session. Returns null when it does not exist. */
  get(id: string): Session | null {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(id) as unknown as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  /**
   * The sessions, newest first.
   *
   * Archived sessions are hidden unless they are asked for, so the sidebar
   * shows what the user is working on.
   */
  list(options: { includeArchived?: boolean; limit?: number } = {}): Session[] {
    const limit = options.limit ?? 100;
    const sql = options.includeArchived
      ? 'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?'
      : 'SELECT * FROM sessions WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?';
    const rows = this.db.prepare(sql).all(limit) as unknown as SessionRow[];
    return rows.map(toSession);
  }

  /** Renames a session. Returns null when it does not exist. */
  rename(id: string, title: string): Session | null {
    this.db
      .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, new Date().toISOString(), id);
    return this.get(id);
  }

  /** Archives or un-archives a session. */
  setArchived(id: string, archived: boolean): Session | null {
    this.db
      .prepare('UPDATE sessions SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, new Date().toISOString(), id);
    return this.get(id);
  }

  /** Marks a session as touched, so it sorts to the top of the sidebar. */
  touch(id: string): void {
    this.db
      .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                     */
/* -------------------------------------------------------------------------- */

/** One message of a conversation. */
export interface StoredMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  /** Free-form metadata, as JSON. */
  meta: Record<string, unknown> | null;
  createdAt: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: string;
  content: string;
  meta: string | null;
  created_at: string;
}

/**
 * The conversation.
 *
 * The message list is **append-only**: nothing is ever reordered or
 * re-summarised in place. That is what keeps the provider's cached prefix
 * matching, and it is why the sequence numbers only ever go up.
 */
export class MessageStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Appends a message and returns it. */
  append(input: {
    sessionId: string;
    role: StoredMessage['role'];
    content: string;
    meta?: Record<string, unknown>;
  }): StoredMessage {
    const id = `msg_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const seq = this.nextSeq(input.sessionId);
    const meta = input.meta ? JSON.stringify(input.meta) : null;

    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, seq, role, content, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.sessionId, seq, input.role, input.content, meta, createdAt);

    return {
      id,
      sessionId: input.sessionId,
      seq,
      role: input.role,
      content: input.content,
      meta: input.meta ?? null,
      createdAt,
    };
  }

  /** The messages of a session, oldest first. */
  list(sessionId: string, limit = 500): StoredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(sessionId, limit) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  /** The next message sequence number for a session. */
  nextSeq(sessionId: string): number {
    const row = this.db
      .prepare('SELECT MAX(seq) AS max FROM messages WHERE session_id = ?')
      .get(sessionId) as { max: number | null } | undefined;
    return (row?.max ?? 0) + 1;
  }
}

function toMessage(row: MessageRow): StoredMessage {
  let meta: Record<string, unknown> | null = null;
  if (row.meta) {
    try {
      meta = JSON.parse(row.meta) as Record<string, unknown>;
    } catch {
      meta = null;
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    role: row.role as StoredMessage['role'],
    content: row.content,
    meta,
    createdAt: row.created_at,
  };
}

export { transaction };
