import { describe, expect, it } from 'vitest';

import {
  applyOperation,
  deepEquals,
  matchesArguments,
  matchesValue,
} from '../src/policy/matchers.js';
import { PolicyEngine } from '../src/policy/engine.js';
import type { Policy, PolicyEffect } from '../src/store/policies.js';

/**
 * The policy engine.
 *
 * The decision is the server's, from the tool being called and the
 * user's own policies. These tests are the proof that the model cannot
 * influence it: the engine never sees the model.
 */
describe('the argument matchers', () => {
  it('compares values by type', () => {
    expect(applyOperation('equals', 1, 1)).toBe(true);
    expect(applyOperation('equals', 1, '1')).toBe(false);
    expect(applyOperation('equals', 'a', 'a')).toBe(true);
  });

  it('supports the seven operations', () => {
    expect(applyOperation('equals', 'fix/x', 'fix/x')).toBe(true);
    expect(applyOperation('notEquals', 'fix/x', 'other')).toBe(true);
    expect(applyOperation('startsWith', 'fix/', 'fix/x')).toBe(true);
    expect(applyOperation('startsWith', 'fix/', 'hotfix/x')).toBe(false);
    expect(applyOperation('endsWith', '/x', 'fix/x')).toBe(true);
    expect(applyOperation('contains', 'fix', 'fix/x')).toBe(true);
    expect(applyOperation('matches', '^fix/', 'fix/x')).toBe(true);
    expect(applyOperation('matches', '^nope', 'fix/x')).toBe(false);
    expect(applyOperation('in', ['a', 'b'], 'b')).toBe(true);
    expect(applyOperation('in', ['a', 'b'], 'c')).toBe(false);
  });

  it('does not blow up on a pattern that is not a regular expression', () => {
    expect(applyOperation('matches', '([unclosed', 'anything')).toBe(false);
  });

  it('treats an object as an AND and an array as an OR', () => {
    expect(
      matchesValue({ startsWith: 'fix/', endsWith: '/x' }, 'fix/x'),
    ).toBe(true);
    expect(
      matchesValue({ startsWith: 'fix/', endsWith: '/y' }, 'fix/x'),
    ).toBe(false);

    expect(matchesValue([{ equals: 'a' }, { equals: 'b' }], 'b')).toBe(true);
    expect(matchesValue([{ equals: 'a' }, { equals: 'b' }], 'c')).toBe(false);
  });

  it('treats a bare value as equals', () => {
    expect(matchesValue('fix/x', 'fix/x')).toBe(true);
    expect(matchesValue('fix/x', 'other')).toBe(false);
  });

  it('matches every argument the policy mentions', () => {
    expect(
      matchesArguments(
        { name: { startsWith: 'fix/' }, baseBranch: { equals: 'main' } },
        { name: 'fix/x', baseBranch: 'main' },
      ),
    ).toBe(true);

    expect(
      matchesArguments(
        { name: { startsWith: 'fix/' }, baseBranch: { equals: 'main' } },
        { name: 'fix/x', baseBranch: 'dev' },
      ),
    ).toBe(false);
  });

  it('ignores the arguments the policy does not mention', () => {
    expect(
      matchesArguments({ name: { startsWith: 'fix/' } }, { name: 'fix/x', other: 1 }),
    ).toBe(true);
  });

  it('compares arrays structurally', () => {
    expect(deepEquals([1, 2], [1, 2])).toBe(true);
    expect(deepEquals([1, 2], [2, 1])).toBe(false);
  });
});

/** A policy source backed by a list. */
class FakePolicies {
  constructor(private readonly policies: Policy[]) {}
  listForSession(): Policy[] {
    return this.policies;
  }
}

function policy(input: {
  id: string;
  toolName: string;
  effect: PolicyEffect;
  match?: Record<string, unknown> | null;
  sessionId?: string | null;
  enabled?: boolean;
  priority?: number;
  label?: string | null;
  createdAt?: string;
}): Policy {
  return {
    id: input.id,
    sessionId: input.sessionId ?? null,
    toolName: input.toolName,
    match: input.match ?? null,
    effect: input.effect,
    enabled: input.enabled ?? true,
    priority: input.priority ?? 100,
    label: input.label ?? null,
    createdAt: input.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('the policy engine', () => {
  it('asks about a tool that writes when no policy matches', () => {
    const engine = new PolicyEngine(new FakePolicies([]));
    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'create_branch',
      arguments: { name: 'fix/x' },
      writes: true,
    });

    expect(decision.effect).toBe('ask');
    expect(decision.policy).toBeNull();
    expect(decision.matchedPolicy).toBeNull();
    expect(decision.reason).toBe('no policy matched, and this tool writes');
  });

  it('allows a read-only tool when no policy matches', () => {
    const engine = new PolicyEngine(new FakePolicies([]));
    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'echo',
      arguments: {},
      writes: false,
    });

    expect(decision.effect).toBe('allow');
    expect(decision.reason).toBe('no policy matched, and this tool only reads');
  });

  it('lets an allow policy run the tool without asking', () => {
    const engine = new PolicyEngine(
      new FakePolicies([
        policy({
          id: 'pol_1',
          toolName: 'create_branch',
          effect: 'allow',
          match: { name: { startsWith: 'fix/' } },
          label: 'fix branches',
        }),
      ]),
    );

    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'create_branch',
      arguments: { name: 'fix/x' },
      writes: true,
    });

    expect(decision.effect).toBe('allow');
    expect(decision.matchedPolicy).toBe('fix branches');
    expect(decision.policy?.id).toBe('pol_1');
  });

  it('lets a deny policy refuse the tool, and says why', () => {
    const engine = new PolicyEngine(
      new FakePolicies([
        policy({
          id: 'pol_1',
          toolName: 'create_branch',
          effect: 'deny',
          label: 'no branches',
        }),
      ]),
    );

    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'create_branch',
      arguments: { name: 'fix/x' },
      writes: true,
    });

    expect(decision.effect).toBe('deny');
    expect(decision.reason).toContain('no branches');
  });

  it('does not let a policy for another tool decide', () => {
    const engine = new PolicyEngine(
      new FakePolicies([
        policy({ id: 'pol_1', toolName: 'echo', effect: 'deny' }),
      ]),
    );

    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'create_branch',
      arguments: {},
      writes: true,
    });

    expect(decision.effect).toBe('ask');
  });

  it('ignores a disabled policy', () => {
    const engine = new PolicyEngine(
      new FakePolicies([
        policy({
          id: 'pol_1',
          toolName: 'create_branch',
          effect: 'deny',
          enabled: false,
        }),
      ]),
    );

    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'create_branch',
      arguments: {},
      writes: true,
    });

    expect(decision.effect).toBe('ask');
  });

  it('lets the lowest priority number win', () => {
    const engine = new PolicyEngine(
      new FakePolicies([
        policy({ id: 'pol_low', toolName: 'echo', effect: 'deny', priority: 10 }),
        policy({ id: 'pol_high', toolName: 'echo', effect: 'allow', priority: 90 }),
      ]),
    );

    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'echo',
      arguments: {},
      writes: false,
    });

    expect(decision.effect).toBe('deny');
    expect(decision.policy?.id).toBe('pol_low');
  });

  it('lets a per-session policy beat a global one at the same priority', () => {
    const engine = new PolicyEngine(
      new FakePolicies([
        policy({ id: 'pol_global', toolName: 'echo', effect: 'allow' }),
        policy({
          id: 'pol_session',
          toolName: 'echo',
          effect: 'deny',
          sessionId: 'ses_1',
        }),
      ]),
    );

    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'echo',
      arguments: {},
      writes: false,
    });

    expect(decision.effect).toBe('deny');
    expect(decision.policy?.id).toBe('pol_session');
  });

  it('takes the first match and does not fall through', () => {
    const engine = new PolicyEngine(
      new FakePolicies([
        policy({
          id: 'pol_1',
          toolName: 'create_branch',
          effect: 'deny',
          match: { name: { startsWith: 'fix/' } },
        }),
        policy({
          id: 'pol_2',
          toolName: 'create_branch',
          effect: 'allow',
          match: { name: { startsWith: 'fix/' } },
        }),
      ]),
    );

    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'create_branch',
      arguments: { name: 'fix/x' },
      writes: true,
    });

    expect(decision.effect).toBe('deny');
    expect(decision.policy?.id).toBe('pol_1');
  });

  it('does not match a policy whose arguments do not fit', () => {
    const engine = new PolicyEngine(
      new FakePolicies([
        policy({
          id: 'pol_1',
          toolName: 'create_branch',
          effect: 'allow',
          match: { name: { startsWith: 'fix/' } },
        }),
      ]),
    );

    const decision = engine.evaluate({
      sessionId: 'ses_1',
      toolName: 'create_branch',
      arguments: { name: 'attacker-controlled' },
      writes: true,
    });

    expect(decision.effect).toBe('ask');
  });
});
