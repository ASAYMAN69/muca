import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** What a policy does when it matches. */
export type PolicyEffect = 'allow' | 'ask' | 'deny';

/** One policy: a tool, optional argument matchers, and an effect. */
export interface Policy {
  id: string;
  /** `null` for a global policy, a session id for a per-session one. */
  sessionId: string | null;
  toolName: string;
  /** The argument matchers, as a JSON object. `null` matches any argument. */
  match: Record<string, unknown> | null;
  effect: PolicyEffect;
  enabled: boolean;
  /** Lower wins. */
  priority: number;
  label: string | null;
  createdAt: string;
}

interface PolicyRow {
  id: string;
  session_id: string | null;
  tool_name: string;
  match: string | null;
  effect: string;
  enabled: number;
  priority: number;
  label: string | null;
  created_at: string;
}

/**
 * The policies.
 *
 * A policy says what may happen with a tool, without the user having to
 * be there. They are the server's side of the permission decision: the
 * model never influences them.
 */
export class PolicyStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Creates a policy. */
  create(input: {
    id?: string;
    sessionId?: string | null;
    toolName: string;
    match?: Record<string, unknown> | null;
    effect: PolicyEffect;
    enabled?: boolean;
    priority?: number;
    label?: string | null;
  }): Policy {
    const policy: Policy = {
      id: input.id ?? `pol_${randomUUID()}`,
      sessionId: input.sessionId ?? null,
      toolName: input.toolName,
      match: input.match ?? null,
      effect: input.effect,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
      label: input.label ?? null,
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO policies (id, session_id, tool_name, match, effect, enabled,
                               priority, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        policy.id,
        policy.sessionId,
        policy.toolName,
        policy.match ? JSON.stringify(policy.match) : null,
        policy.effect,
        policy.enabled ? 1 : 0,
        policy.priority,
        policy.label,
        policy.createdAt,
      );

    return policy;
  }

  /**
   * The policies that could apply to a session.
   *
   * Both the global policies and the session's own are returned; the
   * engine decides which one wins.
   */
  listForSession(sessionId: string): Policy[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM policies
         WHERE session_id IS NULL OR session_id = ?
         ORDER BY priority ASC, created_at ASC`,
      )
      .all(sessionId) as unknown as PolicyRow[];
    return rows.map(toPolicy);
  }

  /** Every policy, global and per session. */
  listAll(): Policy[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM policies ORDER BY priority ASC, created_at ASC',
      )
      .all() as unknown as PolicyRow[];
    return rows.map(toPolicy);
  }

  /** Reads one policy. */
  get(id: string): Policy | null {
    const row = this.db.prepare('SELECT * FROM policies WHERE id = ?').get(id) as
      | PolicyRow
      | undefined;
    return row ? toPolicy(row) : null;
  }

  /** Edits a policy. Returns null when it does not exist. */
  update(
    id: string,
    patch: Partial<
      Pick<
        Policy,
        'sessionId' | 'toolName' | 'match' | 'effect' | 'enabled' | 'priority' | 'label'
      >
    >,
  ): Policy | null {
    const current = this.get(id);
    if (!current) return null;

    const next: Policy = {
      ...current,
      ...patch,
      match: patch.match === undefined ? current.match : patch.match,
    };

    this.db
      .prepare(
        `UPDATE policies SET session_id = ?, tool_name = ?, match = ?, effect = ?,
                            enabled = ?, priority = ?, label = ?
         WHERE id = ?`,
      )
      .run(
        next.sessionId,
        next.toolName,
        next.match ? JSON.stringify(next.match) : null,
        next.effect,
        next.enabled ? 1 : 0,
        next.priority,
        next.label,
        id,
      );

    return next;
  }

  /** Deletes a policy. Returns true when a row was removed. */
  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM policies WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }
}

function toPolicy(row: PolicyRow): Policy {
  let match: Record<string, unknown> | null = null;
  if (row.match) {
    try {
      const parsed: unknown = JSON.parse(row.match);
      match =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      match = null;
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    match,
    effect: row.effect as PolicyEffect,
    enabled: row.enabled === 1,
    priority: row.priority,
    label: row.label,
    createdAt: row.created_at,
  };
}
