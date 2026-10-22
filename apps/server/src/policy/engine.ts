import type { Policy, PolicyEffect } from '../store/policies.js';
import { matchesArguments, type MatchObject } from './matchers.js';

/**
 * The policy engine.
 *
 * The decision is made by the **server**, from the tool being called and
 * the user's own policies. The model cannot request, escalate or
 * influence it: it never sees a policy, and it cannot change one.
 */
export interface PolicyDecision {
  /** What happens to the call. */
  effect: PolicyEffect;
  /** The policy that decided, or null when the default applied. */
  policy: Policy | null;
  /** The name of the deciding policy: its label, or its id. */
  matchedPolicy: string | null;
  /** Why the decision was made, in words the user can read. */
  reason: string;
}

/** The effect a tool gets when no policy matches. */
export type DefaultEffect = 'allow' | 'ask';

/**
 * How an effect reads in a sentence.
 *
 * The reason is shown to the user, so it has to read like English:
 * "policy 'fix/* branches' asks".
 */
function describeEffect(effect: PolicyEffect): string {
  switch (effect) {
    case 'allow':
      return 'allows';
    case 'ask':
      return 'asks';
    case 'deny':
      return 'denies';
  }
}

/** The minimum a policy source has to offer. */
export interface PolicySource {
  listForSession(sessionId: string): Policy[];
}

/**
 * Evaluates the policies for one call.
 */
export class PolicyEngine {
  constructor(private readonly policies: PolicySource) {}

  /**
   * Decides what happens to a call.
   *
   * @param writes True when the tool changes state. A tool that writes
   *   with no policy is **asked** about; a read-only tool is **allowed**.
   */
  evaluate(input: {
    sessionId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    writes: boolean;
  }): PolicyDecision {
    const candidates = this.candidates(input.sessionId, input.toolName);

    for (const policy of candidates) {
      if (!matchesArguments(policy.match as MatchObject | null, input.arguments)) {
        continue;
      }
      const name = policy.label ?? policy.id;
      return {
        effect: policy.effect,
        policy,
        matchedPolicy: name,
        reason: `policy '${name}' ${describeEffect(policy.effect)}`,
      };
    }

    // No policy matched. The default is by tool class.
    if (input.writes) {
      return {
        effect: 'ask',
        policy: null,
        matchedPolicy: null,
        reason: 'no policy matched, and this tool writes',
      };
    }

    return {
      effect: 'allow',
      policy: null,
      matchedPolicy: null,
      reason: 'no policy matched, and this tool only reads',
    };
  }

  /**
   * The policies that could apply, in the order they are tried.
   *
   * Enabled policies only, highest priority first (lowest number wins),
   * then per-session before global, then oldest. The **first** match
   * decides: there is no fall-through.
   */
  private candidates(sessionId: string, toolName: string): Policy[] {
    return this.policies
      .listForSession(sessionId)
      .filter((policy) => policy.enabled && policy.toolName === toolName)
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;

        // A per-session policy beats a global one.
        const aGlobal = a.sessionId === null ? 1 : 0;
        const bGlobal = b.sessionId === null ? 1 : 0;
        if (aGlobal !== bGlobal) return aGlobal - bGlobal;

        if (a.createdAt !== b.createdAt) {
          return a.createdAt < b.createdAt ? -1 : 1;
        }
        return a.id.localeCompare(b.id);
      });
  }
}
