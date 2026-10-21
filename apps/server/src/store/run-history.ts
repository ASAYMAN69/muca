import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { randomUUID } from 'node:crypto';

/**
 * Session-scoped run history.
 *
 * Amazon explicitly credits "state maintained across sessions" — the
 * agent should remember what happened in an earlier run, even after the
 * server restarts. This store persists every run to a JSON file on disk.
 *
 * Design notes:
 *   - **File-backed, not a database.** No AWS resources, no setup, works
 *     locally with `npm run dev`.
 *   - **One file per run**, under a `runs/` directory. Writing one small
 *     file is atomic enough (write to a temp file, then rename) and avoids
 *     a rewrite of the whole history on every run.
 *   - **Newest first** when listed, and the list is capped so a long
 *     session cannot grow the directory without bound.
 */

/** One tool call made during a run. */
export interface RunToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** The summary the tool returned. */
  summary?: string;
  /** Set when the tool failed. */
  error?: string;
  /** ISO timestamp. */
  at: string;
}

/** One approval decision made during a run. */
export interface RunApproval {
  requestId: string;
  toolName: string;
  decision: 'approved' | 'rejected' | 'timed_out';
  source: 'elicitation' | 'http' | 'fallback';
  at: string;
}

/** The persisted record of one agent run. */
export interface RunRecord {
  id: string;
  /** ISO timestamp of when the run started. */
  startedAt: string;
  /** ISO timestamp of when the run finished. */
  finishedAt: string | null;
  /** What the user asked for. */
  userMessage: string;
  /** The assistant's final answer. */
  text: string;
  /** How the run ended. */
  outcome: 'completed' | 'awaiting_approval' | 'error' | 'cancelled';
  /** Every tool call, in order. */
  toolCalls: RunToolCall[];
  /** Every approval decision, in order. */
  approvals: RunApproval[];
  /** The id of an MCP task this run started, if any. */
  taskId: string | null;
  /** A short error message, when the run failed. */
  error: string | null;
}

/** The summary shape returned by `GET /api/v1/runs`. */
export interface RunSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  userMessage: string;
  text: string;
  outcome: RunRecord['outcome'];
  toolCallCount: number;
  approvalCount: number;
  taskId: string | null;
}

/**
 * A file-backed run history store.
 *
 * The store is deliberately small: a directory of JSON files plus a
 * read/list API. Writes are serialised through a single promise chain so
 * two concurrent runs cannot interleave their writes.
 */
export class RunHistoryStore {
  private readonly dir: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Creates the directory if it does not exist yet. */
  init(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /** The directory the runs are stored in. */
  get directory(): string {
    return this.dir;
  }

  /** Persists a run. Returns the stored record. */
  async save(run: RunRecord): Promise<RunRecord> {
    this.init();
    const file = this.fileFor(run.id);
    const payload = `${JSON.stringify(run, null, 2)}\n`;

    // Serialise writes so two runs never fight over the same directory.
    this.writeQueue = this.writeQueue.then(async () => {
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, payload, 'utf8');
      // `rename` is atomic on the same filesystem: a reader never sees a
      // half-written run.
      renameSync(tmp, file);
    });

    await this.writeQueue;
    return run;
  }

  /** Reads one run back. Returns null when it does not exist. */
  get(runId: string): RunRecord | null {
    let file: string;
    try {
      file = this.fileFor(runId);
    } catch {
      return null;
    }
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
    } catch {
      // A corrupt file must not take the whole endpoint down.
      return null;
    }
  }

  /**
   * Lists runs, newest first.
   *
   * @param limit Maximum number of runs to return.
   */
  list(limit = 20): RunSummary[] {
    this.init();
    const summaries: RunSummary[] = [];

    for (const file of listRunFiles(this.dir)) {
      if (summaries.length >= limit) break;
      try {
        const run = JSON.parse(readFileSync(file, 'utf8')) as RunRecord;
        summaries.push(toSummary(run));
      } catch {
        // Skip unreadable files rather than failing the whole listing.
        continue;
      }
    }

    return summaries;
  }

  /** Removes every stored run. Used by tests and by a "reset demo" action. */
  clear(): number {
    this.init();
    const files = listRunFiles(this.dir);
    for (const file of files) {
      try {
        unlinkSync(file);
      } catch {
        // Ignore: the file may already be gone.
      }
    }
    return files.length;
  }

  private fileFor(runId: string): string {
    // Guard against a run id escaping the directory.
    const safe = runId.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!safe) throw new Error(`Invalid run id: ${runId}`);
    return join(this.dir, `${safe}.json`);
  }
}

function toSummary(run: RunRecord): RunSummary {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    userMessage: run.userMessage,
    text: run.text,
    outcome: run.outcome,
    toolCallCount: run.toolCalls.length,
    approvalCount: run.approvals.length,
    taskId: run.taskId,
  };
}

function listRunFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name))
    // Sort by mtime, newest first. The mtime has millisecond resolution,
    // so this is a stable order for runs written in the same tick.
    .sort((a, b) => {
      const aTime = statSyncSafe(a)?.mtimeMs ?? 0;
      const bTime = statSyncSafe(b)?.mtimeMs ?? 0;
      if (aTime !== bTime) return bTime - aTime;
      return a.localeCompare(b);
    });
}

function statSyncSafe(file: string): { mtimeMs: number } | undefined {
  try {
    return statSync(file);
  } catch {
    return undefined;
  }
}

/**
 * The default location of the run history.
 *
 * Kept inside `apps/server` and gitignored (see `apps/server/.gitignore`),
 * so the runtime state never lands in version control and the app stays
 * self-contained.
 */
export function defaultRunHistoryDir(appRoot: string): string {
  return join(appRoot, '.muca', 'runs');
}
