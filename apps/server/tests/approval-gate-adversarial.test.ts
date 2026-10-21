/**
 * Independent verification of the P1 fix.
 *
 * Written from the threat model, not from the agent's tests: try to get a
 * destructive call approved without the user having seen *that* action.
 */
import { describe, expect, it } from 'vitest';

import {
  HttpApprovalGate,
  argumentsMatch,
  type ApprovedAction,
} from '../src/ai/approval-gate.js';

const action = (over: Partial<ApprovedAction> = {}): ApprovedAction => ({
  callId: 'call_parked',
  toolName: 'create_branch',
  arguments: { name: 'feature/approved', baseBranch: 'main' },
  ...over,
});

function gate(actions: ApprovedAction[] = []) {
  return new HttpApprovalGate(actions);
}

const ask = (
  g: HttpApprovalGate,
  args: Record<string, unknown>,
  requestId = 'call_model',
) =>
  g.request({
    approval: {
      toolName: 'create_branch',
      title: 'Create branch',
      message: 'Create branch',
      arguments: args,
    },
    requestId,
    // A hostile client could claim any id; the fallback must not save it.
    fallback: async () => true,
  });

describe('P1 — an approval authorises an action, not a tool', () => {
  it('refuses a different branch under the same tool', async () => {
    const g = gate([action()]);
    const ok = await ask(g, { name: 'attacker-controlled', baseBranch: 'main' });
    expect(ok).toBe(false);
  });

  it('approves the exact action, even with a different call id', async () => {
    const g = gate([action()]);
    const ok = await ask(g, { name: 'feature/approved', baseBranch: 'main' });
    expect(ok).toBe(true);
  });

  it('ignores key order', async () => {
    const g = gate([action({ arguments: { baseBranch: 'main', name: 'x' } })]);
    const ok = await ask(g, { name: 'x', baseBranch: 'main' });
    expect(ok).toBe(true);
  });

  it('treats a defaulted field as the same action', async () => {
    // The parked action spelled out baseBranch; the new call omits it.
    // Without the normaliser these differ. The gate is given one that
    // mimics the tool's Zod default.
    const g = new HttpApprovalGate(
      [action()],
      undefined,
      () => (args) => ({ baseBranch: 'main', ...args }),
    );
    const ok = await ask(g, { name: 'feature/approved' });
    expect(ok).toBe(true);
  });

  it('does not treat a string as the number it looks like', () => {
    expect(argumentsMatch({ n: 1 }, { n: '1' })).toBe(false);
    expect(argumentsMatch({ n: 1, b: 2 }, { b: 2, n: 1 })).toBe(true);
  });

  it('cannot replay one approval for two calls', async () => {
    const g = gate([action()]);
    expect(await ask(g, { name: 'feature/approved', baseBranch: 'main' }, 'a')).toBe(true);
    expect(await ask(g, { name: 'feature/approved', baseBranch: 'main' }, 'b')).toBe(false);
  });

  it('does not let an unrelated approved action leak across tools', async () => {
    const g = gate([action({ toolName: 'open_pull_request' })]);
    const ok = await ask(g, { name: 'feature/approved', baseBranch: 'main' });
    expect(ok).toBe(false);
  });

  it('ignores an approval the user never gave (empty set)', async () => {
    const g = gate([]);
    const ok = await ask(g, { name: 'feature/approved', baseBranch: 'main' });
    expect(ok).toBe(false);
    expect(g.isPending('call_model')).toBe(true);
  });
});
