import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The database.
 *
 * One global SQLite database at `~/.adh/database/muca.db`, created on
 * first use. It is the durable half of the live protocol: the sessions,
 * the messages, the event log the replay reads from, the runs, the
 * approvals, the outstanding requests and the policies.
 *
 * `node:sqlite` is used because Node 24 ships it. There is no ORM and no
 * migration framework: the schema is created with `CREATE TABLE IF NOT
 * EXISTS` every time the database is opened, which is enough for a schema
 * that only ever grows by adding a table.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, outcome TEXT, error TEXT, tool_call_count INTEGER DEFAULT 0,
  approval_count INTEGER DEFAULT 0, task_id TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, request_id TEXT,
  tool_name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL,
  policy_id TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT, status TEXT NOT NULL, answer TEXT,
  created_at TEXT NOT NULL, answered_at TEXT
);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT NOT NULL,
  match TEXT, effect TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100, label TEXT, created_at TEXT NOT NULL
);
`;

/**
 * The path of the global database.
 *
 * `~/.adh/database/muca.db` — one database for the whole machine, not one
 * per project, so a session survives moving between checkouts.
 */
export function defaultDatabasePath(): string {
  return join(homedir(), '.adh', 'database', 'muca.db');
}

/**
 * The database handle.
 *
 * The path is a parameter, not a constant, so the tests can point at a
 * temporary file. **The tests must never touch the user's real database.**
 */
export class Database {
  readonly handle: DatabaseSync;

  constructor(readonly path: string) {
    // `:memory:` is the in-memory database, used by the tests. It has no
    // directory, and the write-ahead log does not apply to it.
    const inMemory = path === ':memory:';
    if (!inMemory) {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.handle = new DatabaseSync(path);

    if (!inMemory) {
      // The write-ahead log lets a reader work while a writer is running,
      // which is what the socket and the REST API do at the same time.
      this.handle.exec('PRAGMA journal_mode = WAL;');
    }
    this.handle.exec('PRAGMA busy_timeout = 5000;');
    this.handle.exec(SCHEMA_SQL);
  }

  /** Closes the handle. The file stays on disk. */
  close(): void {
    this.handle.close();
  }
}

/**
 * Runs a function inside a transaction.
 *
 * `node:sqlite` has no transaction helper, so the statements are wrapped
 * by hand. A failure rolls back, so a half-written run never lands.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // A rollback that fails must not mask the original error.
    }
    throw error;
  }
}

/**
 * Casts a row `node:sqlite` returned into a typed row.
 *
 * The driver types a row as `Record<string, SQLOutputValue>`, which no
 * concrete row shape overlaps with. The cast is safe: the column names
 * in the query and in the row type are written next to each other.
 */
export function row<T>(value: unknown): T | undefined {
  return value as T | undefined;
}

/** Casts the rows `node:sqlite` returned into typed rows. */
export function rows<T>(value: unknown): T[] {
  return value as T[];
}
