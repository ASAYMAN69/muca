import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** What happened to a permission request. */
export type ApprovalStatus = 'pending' | 'allowed' | 'denied';

/** One permission request and its decision. */
export interface StoredApproval {
  id: string;
  sessionId: string;
  runId: string | null;
  requestId: string | null;
  toolName: string;
  /** The exact arguments the tool would run with, as JSON. */
  arguments: Record<string, unknown>;
  status: ApprovalStatus;
  policyId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  run_id: string | null;
  request_id: string | null;
  tool_name: string;
  arguments: string;
  status: string;
  policy_id: string | null;
  created_at: string;
  decided_at: string | null;
}

/**
 * The approvals.
 *
 * Every permission the server asks for is recorded here, with the exact
 * arguments the tool would run with. The record is written when the
 * request is made and updated when the user decides, so the audit trail
 * shows what was asked and what was answered.
 */
export class ApprovalStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Records a permission request. */
  request(input: {
    id?: string;
    sessionId: string;
    runId?: string | null;
    requestId?: string | null;
    toolName: string;
    arguments: Record<string, unknown>;
    policyId?: string | null;
    status?: ApprovalStatus;
  }): StoredApproval {
    const id = input.id ?? `apr_${randomUUID()}`;
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, run_id, request_id, tool_name,
                               arguments, status, policy_id, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.sessionId,
        input.runId ?? null,
        input.requestId ?? null,
        input.toolName,
        JSON.stringify(input.arguments ?? {}),
        input.status ?? 'pending',
        input.policyId ?? null,
        createdAt,
      );

    return {
      id,
      sessionId: input.sessionId,
      runId: input.runId ?? null,
      requestId: input.requestId ?? null,
      toolName: input.toolName,
      arguments: input.arguments ?? {},
      status: input.status ?? 'pending',
      policyId: input.policyId ?? null,
      createdAt,
      decidedAt: null,
    };
  }

  /** Records the decision on a permission request. */
  decide(input: {
    requestId: string;
    status: Exclude<ApprovalStatus, 'pending'>;
    decidedAt?: string;
  }): void {
    this.db
      .prepare(
        'UPDATE approvals SET status = ?, decided_at = ? WHERE request_id = ?',
      )
      .run(
        input.status,
        input.decidedAt ?? new Date().toISOString(),
        input.requestId,
      );
  }

  /** The permission requests of a session that are still waiting. */
  listPending(sessionId: string): StoredApproval[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM approvals WHERE session_id = ? AND status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as unknown as ApprovalRow[];
    return rows.map(toApproval);
  }

  /** The permission requests of a session, newest first. */
  listForSession(sessionId: string, limit = 50): StoredApproval[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      )
      .all(sessionId, limit) as unknown as ApprovalRow[];
    return rows.map(toApproval);
  }
}

function toApproval(row: ApprovalRow): StoredApproval {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(row.arguments) as Record<string, unknown>;
  } catch {
    args = {};
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    requestId: row.request_id,
    toolName: row.tool_name,
    arguments: args,
    status: row.status as ApprovalStatus,
    policyId: row.policy_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}
