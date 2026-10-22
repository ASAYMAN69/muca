import { describe, expect, it } from 'vitest';

import { LivePolicyGate, type LiveGateHooks } from '../src/live/policy-gate.js';
import { PolicyEngine } from '../src/policy/engine.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import type { Policy } from '../src/store/policies.js';

/**
 * A policy that refuses a tool must **not** leave the run waiting.
 *
 * The gate emits a `permission_requested` frame even when a policy has
 * already answered, so the user can see what was refused and which policy
 * refused it. The run must not park on it: the decision is made, and
 * parking left the agent waiting forever for a decision that was never
 * going to come.
 */

function policy(over: Partial<Policy> = {}): Policy {
  return {
    id: 'pol_test',
    sessionId: null,
    toolName: 'create_branch',
    match: null,
    effect: 'deny',
    enabled: true,
    priority: 100,
    label: 'no blocked branches',
    createdAt: '2026-10-22T00:00:00.000Z',
    ...over,
  };
}

function buildGate(policies: Policy[]) {
  const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
  const decisions: Array<{ requestId: string; status: string }> = [];

  const engine = new PolicyEngine({
    listForSession: () => policies,
  });

  const hooks: LiveGateHooks = {
    sessionId: 'ses_test',
    runId: 'run_test',
    emit: (type, data) => {
      frames.push({ type, data: data as Record<string, unknown> });
    },
    recordRequest: () => {},
    recordDecision: (input) => {
      decisions.push({ requestId: input.requestId, status: input.status });
    },
    // If the gate ever parks on a decided permission, this throws.
    awaitDecision: async () => {
      throw new Error('the run must not park on a policy that already answered');
    },
  };

  const gate = new LivePolicyGate(
    engine,
    new ToolRegistry().registerAll(createTools()),
    hooks,
  );

  return { gate, frames, decisions };
}

const ask = (gate: LivePolicyGate) =>
  gate.request({
    approval: {
      toolName: 'create_branch',
      title: 'Create branch',
      message: 'Create branch (name="blocked/probe")',
      arguments: { name: 'blocked/probe' },
    },
    requestId: 'call_model_1',
    fallback: async () => false,
  });

describe('a policy that refuses does not leave the run waiting', () => {
  it('refuses the tool and does not park', async () => {
    const { gate, decisions } = buildGate([policy()]);

    const allowed = await ask(gate);

    expect(allowed).toBe(false);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.status).toBe('denied');
  });

  it('marks the frame as already resolved, so the client shows no buttons', async () => {
    const { gate, frames } = buildGate([policy()]);

    await ask(gate);

    const request = frames.find((f) => f.type === 'permission_requested');
    expect(request).toBeDefined();
    expect(request!.data.autoResolved).toBe(true);
    // The information the user needs is still there.
    expect(request!.data.tool).toBe('create_branch');
    expect(request!.data.toolCallId).toBe('call_model_1');
    expect(request!.data.arguments).toMatchObject({ name: 'blocked/probe' });
  });

  it('an allow policy runs the tool and asks nobody', async () => {
    const { gate, frames } = buildGate([policy({ effect: 'allow' })]);

    const allowed = await ask(gate);

    expect(allowed).toBe(true);
    expect(frames.filter((f) => f.type === 'permission_requested')).toHaveLength(0);
  });

  it('no policy at all asks about a tool that writes', async () => {
    const { gate, frames } = buildGate([]);

    // The gate would park, so this must be caught: the awaitDecision hook
    // throws if it gets there.
    await expect(ask(gate)).rejects.toThrow(/must not park/);

    const request = frames.find((f) => f.type === 'permission_requested');
    expect(request).toBeDefined();
    expect(request!.data.autoResolved).toBe(false);
    expect(request!.data.reason).toMatch(/writes/);
  });
});
