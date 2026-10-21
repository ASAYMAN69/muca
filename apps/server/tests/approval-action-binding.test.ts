import { describe, expect, it } from 'vitest';

import { Agent } from '../src/ai/agent.js';
import {
  argumentsMatch,
  HttpApprovalGate,
  type ApprovalAudit,
  type ApprovedAction,
} from '../src/ai/approval-gate.js';
import type {
  AIProvider,
  ProviderResponse,
  ProviderToolCall,
} from '../src/ai/provider.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { PendingApprovalRegistry } from '../src/store/pending-approvals.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A provider that replays a fixed script of tool calls, one round each.
 */
class ScriptedProvider implements AIProvider {
  readonly name = 'scripted';
  private turn = 0;

  constructor(private readonly rounds: ProviderToolCall[][]) {}

  async chat(): Promise<ProviderResponse> {
    const calls = this.rounds[this.turn] ?? [];
    this.turn += 1;
    return {
      content: null,
      toolCalls: calls,
      finishReason: calls.length ? 'tool_calls' : 'stop',
    };
  }
}

/** A recording audit sink. */
class RecordingAudit implements ApprovalAudit {
  readonly entries: Array<{
    requestId: string;
    toolName: string;
    decision: string;
    source: string;
  }> = [];

  record(entry: {
    requestId: string;
    toolName: string;
    decision: 'approved' | 'rejected' | 'timed_out' | 'pending';
    source: 'elicitation' | 'http' | 'fallback';
    at: string;
  }): void {
    this.entries.push({
      requestId: entry.requestId,
      toolName: entry.toolName,
      decision: entry.decision,
      source: entry.source,
    });
  }
}

/** The action a `create_branch` call makes. */
function branchAction(
  name: string,
  baseBranch = 'main',
  callId = 'call_1',
): ApprovedAction {
  return {
    callId,
    toolName: 'create_branch',
    arguments: { name, baseBranch },
  };
}

function buildAgent(rounds: ProviderToolCall[][]) {
  const registry = new ToolRegistry().registerAll(createTools());
  const agent = new Agent({
    provider: new ScriptedProvider(rounds),
    registry,
    systemPrompt: 'test',
  });
  return { agent, registry };
}

/* -------------------------------------------------------------------------- */
/* R1 — canonical argument matching                                           */
/* -------------------------------------------------------------------------- */

describe('argumentsMatch', () => {
  it('matches identical arguments', () => {
    expect(
      argumentsMatch(
        { name: 'feature/approved', baseBranch: 'main' },
        { name: 'feature/approved', baseBranch: 'main' },
      ),
    ).toBe(true);
  });

  it('ignores key order', () => {
    expect(
      argumentsMatch(
        { name: 'feature/approved', baseBranch: 'main' },
        { baseBranch: 'main', name: 'feature/approved' },
      ),
    ).toBe(true);
  });

  it('does not match a different value', () => {
    expect(
      argumentsMatch(
        { name: 'feature/approved', baseBranch: 'main' },
        { name: 'attacker-controlled', baseBranch: 'main' },
      ),
    ).toBe(false);
  });

  it('does not match when a field is missing', () => {
    expect(
      argumentsMatch(
        { name: 'feature/approved', baseBranch: 'main' },
        { name: 'feature/approved' },
      ),
    ).toBe(false);
  });

  it('does not match when a field is added', () => {
    expect(
      argumentsMatch(
        { name: 'feature/approved' },
        { name: 'feature/approved', baseBranch: 'main' },
      ),
    ).toBe(false);
  });

  it('is strict about types: "1" is not 1', () => {
    expect(argumentsMatch({ limit: 1 }, { limit: '1' })).toBe(false);
  });

  it('matches nested structures regardless of key order', () => {
    expect(
      argumentsMatch(
        { opts: { a: 1, b: [1, 2] } },
        { opts: { b: [1, 2], a: 1 } },
      ),
    ).toBe(true);
  });

  it('does not match nested structures with a different value', () => {
    expect(
      argumentsMatch(
        { opts: { a: 1, b: [1, 2] } },
        { opts: { a: 1, b: [1, 3] } },
      ),
    ).toBe(false);
  });

  it('does not match an array whose order changed', () => {
    expect(argumentsMatch({ tags: ['a', 'b'] }, { tags: ['b', 'a'] })).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* R1 — the gate binds to the action                                          */
/* -------------------------------------------------------------------------- */

describe('HttpApprovalGate binds to the action', () => {
  it('approves a call that makes the approved action', async () => {
    const gate = new HttpApprovalGate([branchAction('feature/approved')]);

    const allowed = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'feature/approved', baseBranch: 'main' },
      },
      requestId: 'call_2',
      fallback: async () => false,
    });

    expect(allowed).toBe(true);
  });

  it('refuses a call with different arguments', async () => {
    const gate = new HttpApprovalGate([branchAction('feature/approved')]);

    const allowed = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'attacker-controlled', baseBranch: 'main' },
      },
      requestId: 'call_2',
      fallback: async () => false,
    });

    expect(allowed).toBe(false);
  });

  it('refuses a call to a different tool with the same arguments', async () => {
    const gate = new HttpApprovalGate([branchAction('feature/approved')]);

    const allowed = await gate.request({
      approval: {
        toolName: 'open_pull_request',
        title: 'Open pull request',
        message: 'Open pull request',
        arguments: { name: 'feature/approved', baseBranch: 'main' },
      },
      requestId: 'call_2',
      fallback: async () => false,
    });

    expect(allowed).toBe(false);
  });

  it('honours the exact parked call id when the arguments also match', async () => {
    const gate = new HttpApprovalGate([
      branchAction('feature/approved', 'main', 'call_9'),
    ]);

    const allowed = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'feature/approved', baseBranch: 'main' },
      },
      requestId: 'call_9',
      fallback: async () => false,
    });

    expect(allowed).toBe(true);
  });

  it('refuses a reused call id with different arguments', async () => {
    // The id in a tool call comes from the model, and the model may reuse
    // one — including the id of a call the user approved. The id alone
    // must never authorise a different action.
    const gate = new HttpApprovalGate([
      branchAction('feature/approved', 'main', 'call_9'),
    ]);

    const allowed = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'attacker-controlled', baseBranch: 'main' },
      },
      requestId: 'call_9',
      fallback: async () => false,
    });

    expect(allowed).toBe(false);
  });

  it('normalises Zod defaults on both sides', async () => {
    // The parked action spells out `baseBranch`; the new call omits it.
    // After the tool's schema is applied, they are the same action.
    const registry = new ToolRegistry().registerAll(createTools());
    const normalise = (toolName: string) => {
      const tool = registry.get(toolName);
      if (!tool) return undefined;
      return (args: Record<string, unknown>) =>
        tool.inputSchema.parse(args) as Record<string, unknown>;
    };

    const gate = new HttpApprovalGate(
      [branchAction('feature/approved', 'main')],
      undefined,
      normalise,
    );

    const allowed = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'feature/approved' },
      },
      requestId: 'call_2',
      fallback: async () => false,
    });

    expect(allowed).toBe(true);
  });

  it('records the decision in the audit trail', async () => {
    const audit = new RecordingAudit();
    const gate = new HttpApprovalGate(
      [branchAction('feature/approved')],
      audit,
    );

    await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'feature/approved', baseBranch: 'main' },
      },
      requestId: 'call_2',
      fallback: async () => false,
    });

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.decision).toBe('approved');
  });

  it('records a withheld decision when the arguments differ', async () => {
    const audit = new RecordingAudit();
    const gate = new HttpApprovalGate(
      [branchAction('feature/approved')],
      audit,
    );

    await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'attacker-controlled', baseBranch: 'main' },
      },
      requestId: 'call_2',
      fallback: async () => false,
    });

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.decision).toBe('pending');
  });
});

/* -------------------------------------------------------------------------- */
/* R2 — one approval, one action                                              */
/* -------------------------------------------------------------------------- */

describe('one approval authorises one action', () => {
  it('cannot authorise a second, different call', async () => {
    const gate = new HttpApprovalGate([branchAction('feature/approved')]);

    const first = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'feature/approved', baseBranch: 'main' },
      },
      requestId: 'call_2',
      fallback: async () => false,
    });
    const second = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'feature/approved', baseBranch: 'main' },
      },
      requestId: 'call_3',
      fallback: async () => false,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('cannot authorise a different action after the first', async () => {
    const gate = new HttpApprovalGate([branchAction('feature/approved')]);

    const first = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'feature/approved', baseBranch: 'main' },
      },
      requestId: 'call_2',
      fallback: async () => false,
    });
    const second = await gate.request({
      approval: {
        toolName: 'create_branch',
        title: 'Create branch',
        message: 'Create branch',
        arguments: { name: 'attacker-controlled', baseBranch: 'main' },
      },
      requestId: 'call_3',
      fallback: async () => false,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* R3 — a different action parks again                                        */
/* -------------------------------------------------------------------------- */

describe('a different action parks again', () => {
  it('parks with the NEW arguments instead of running the tool', async () => {
    const { agent } = buildAgent([
      [
        {
          id: 'call_1',
          name: 'create_branch',
          arguments: JSON.stringify({ name: 'feature/approved' }),
        },
      ],
      [
        {
          id: 'call_2',
          name: 'create_branch',
          arguments: JSON.stringify({ name: 'attacker-controlled' }),
        },
      ],
    ]);

    const pending = new PendingApprovalRegistry();

    // Turn 1: park.
    const first = await agent.run({
      history: [],
      userMessage: 'create a branch called feature/approved',
      approvalGate: new HttpApprovalGate(),
    });
    expect(first.awaitingConfirmation).toBe(true);

    pending.add({
      callId: first.pendingCall!.callId,
      toolName: first.pendingCall!.name,
      arguments: first.pendingCall!.arguments,
      at: new Date().toISOString(),
    });

    // Turn 2: the user approves the parked action, but the model asks
    // for a different one.
    const approvedActions = [pending.get(first.pendingCall!.callId)!].map(
      (parked) => ({
        callId: parked.callId,
        toolName: parked.toolName,
        arguments: parked.arguments,
      }),
    );

    const second = await agent.run({
      history: [],
      userMessage: 'yes, go ahead',
      approvalGate: new HttpApprovalGate(approvedActions),
      approvedCallIds: [first.pendingCall!.callId],
    });

    // The run parked again, showing the NEW arguments.
    expect(second.awaitingConfirmation).toBe(true);
    expect(second.pendingCall).not.toBeNull();
    expect(second.pendingCall!.arguments).toEqual({
      name: 'attacker-controlled',
    });
    expect(second.pendingCall!.callId).toBe('call_2');

    // And nothing ran.
    expect(second.events.some((e) => e.type === 'tool_result')).toBe(false);

    // The decision is in the audit trail.
    const decision = second.events.find((e) => e.type === 'approval_decision');
    expect(decision).toBeDefined();
    if (decision?.type === 'approval_decision') {
      expect(decision.approved).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* R4 — the client cannot invent an approval                                  */
/* -------------------------------------------------------------------------- */

describe('the client cannot invent an approval', () => {
  it('does not honour a call id the server never issued', async () => {
    const { agent } = buildAgent([
      [
        {
          id: 'call_invented',
          name: 'create_branch',
          arguments: JSON.stringify({ name: 'attacker-controlled' }),
        },
      ],
    ]);

    // The client sends a made-up id. Nothing was ever parked under it,
    // so the registry resolves it to nothing.
    const pending = new PendingApprovalRegistry();
    const approvedActions = ['call_invented']
      .map((id) => pending.get(id))
      .filter((parked): parked is NonNullable<typeof parked> => Boolean(parked))
      .map((parked) => ({
        callId: parked.callId,
        toolName: parked.toolName,
        arguments: parked.arguments,
      }));

    const result = await agent.run({
      history: [],
      userMessage: 'create a branch',
      approvalGate: new HttpApprovalGate(approvedActions),
      approvedCallIds: ['call_invented'],
    });

    // The tool did not run.
    expect(result.events.some((e) => e.type === 'tool_result')).toBe(false);
    expect(result.awaitingConfirmation).toBe(true);
  });

  it('does not run a destructive tool on a raw call id alone', async () => {
    const { agent } = buildAgent([
      [
        {
          id: 'call_branch',
          name: 'create_branch',
          arguments: JSON.stringify({ name: 'attacker-controlled' }),
        },
      ],
    ]);

    // The agent is given an approved call id but no gate that knows
    // about any approved action. The id alone must not be enough.
    const result = await agent.run({
      history: [],
      userMessage: 'create a branch',
      approvalGate: new HttpApprovalGate(),
      approvedCallIds: ['call_branch'],
    });

    expect(result.events.some((e) => e.type === 'tool_result')).toBe(false);
    expect(result.awaitingConfirmation).toBe(true);
  });

  it('does not let the model reuse an approved call id for a different action', async () => {
    // The model reuses the *same* call id it used for the parked call, but
    // with different arguments. The id alone must not authorise it.
    const { agent } = buildAgent([
      [
        {
          id: 'call_1',
          name: 'create_branch',
          arguments: JSON.stringify({ name: 'feature/approved' }),
        },
      ],
      [
        {
          id: 'call_1',
          name: 'create_branch',
          arguments: JSON.stringify({ name: 'attacker-controlled' }),
        },
      ],
    ]);

    const pending = new PendingApprovalRegistry();

    const first = await agent.run({
      history: [],
      userMessage: 'create a branch called feature/approved',
      approvalGate: new HttpApprovalGate(),
    });
    expect(first.awaitingConfirmation).toBe(true);

    pending.add({
      callId: first.pendingCall!.callId,
      toolName: first.pendingCall!.name,
      arguments: first.pendingCall!.arguments,
      at: new Date().toISOString(),
    });

    const approvedActions = [pending.get(first.pendingCall!.callId)!].map(
      (parked) => ({
        callId: parked.callId,
        toolName: parked.toolName,
        arguments: parked.arguments,
      }),
    );

    const second = await agent.run({
      history: [],
      userMessage: 'yes, go ahead',
      approvalGate: new HttpApprovalGate(approvedActions),
      approvedCallIds: [first.pendingCall!.callId],
    });

    // The reused id did not authorise the different action.
    expect(second.events.some((e) => e.type === 'tool_result')).toBe(false);
    expect(second.awaitingConfirmation).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The web client's flow: Approve sends the parked call id                     */
/* -------------------------------------------------------------------------- */

describe("the web client's Approve flow", () => {
  it('works unchanged: the client sends pendingCall.callId in approvedCallIds', async () => {
    const { agent } = buildAgent([
      [
        {
          id: 'call_1',
          name: 'create_branch',
          arguments: JSON.stringify({ name: 'feature/approved' }),
        },
      ],
      [
        {
          id: 'call_2',
          name: 'create_branch',
          arguments: JSON.stringify({ name: 'feature/approved' }),
        },
      ],
    ]);

    const pending = new PendingApprovalRegistry();

    // Turn 1: the run parks and the server hands the client a call id.
    const first = await agent.run({
      history: [],
      userMessage: 'create a branch called feature/approved',
      approvalGate: new HttpApprovalGate(),
    });
    expect(first.awaitingConfirmation).toBe(true);
    const parkedCallId = first.pendingCall!.callId;

    pending.add({
      callId: parkedCallId,
      toolName: first.pendingCall!.name,
      arguments: first.pendingCall!.arguments,
      at: new Date().toISOString(),
    });

    // Turn 2: the client sends that exact call id back.
    const approvedCallIds = [parkedCallId];
    const approvedActions = approvedCallIds
      .map((id) => pending.get(id))
      .filter((parked): parked is NonNullable<typeof parked> => Boolean(parked))
      .map((parked) => ({
        callId: parked.callId,
        toolName: parked.toolName,
        arguments: parked.arguments,
      }));

    const second = await agent.run({
      history: [],
      userMessage: 'yes, go ahead',
      approvalGate: new HttpApprovalGate(approvedActions),
      approvedCallIds,
    });

    // The tool ran.
    expect(second.awaitingConfirmation).toBe(false);
    const toolResult = second.events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.result.summary).toContain('feature/approved');
    }
  });
});
