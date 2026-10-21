import { describe, expect, it } from 'vitest';

import {
  DenyAllApprovalGate,
  ElicitationApprovalGate,
  HttpApprovalGate,
  isDeferrable,
  noopApprovalAudit,
  type ApprovalAudit,
  type ApprovalRequest,
  type ElicitationCapable,
} from '../src/ai/approval-gate.js';
import { Agent } from '../src/ai/agent.js';
import type {
  AIProvider,
  ProviderResponse,
  ProviderToolCall,
} from '../src/ai/provider.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const APPROVAL: ApprovalRequest = {
  toolName: 'create_branch',
  title: 'Create branch',
  message: 'Create branch (name="fix/x")',
  arguments: { name: 'fix/x' },
};

/** A provider that asks for a destructive tool once, then answers. */
class BranchProvider implements AIProvider {
  readonly name = 'branch-provider';
  private turn = 0;
  readonly receivedMessages: unknown[][] = [];

  async chat(input: { messages: unknown[] }): Promise<ProviderResponse> {
    this.receivedMessages.push(input.messages);
    this.turn += 1;
    if (this.turn === 1) {
      const call: ProviderToolCall = {
        id: 'call_branch',
        name: 'create_branch',
        arguments: JSON.stringify({ name: 'fix/x', baseBranch: 'main' }),
      };
      return { content: null, toolCalls: [call], finishReason: 'tool_calls' };
    }
    return { content: 'Done.', toolCalls: [], finishReason: 'stop' };
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

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('HttpApprovalGate', () => {
  it('approves a call id that is on the approved list', async () => {
    const gate = new HttpApprovalGate(['call_1']);

    const allowed = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(allowed).toBe(true);
  });

  it('refuses a call id that is not on the approved list', async () => {
    const gate = new HttpApprovalGate(['call_other']);

    const allowed = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(allowed).toBe(false);
  });

  it('reports the decision as pending so the run can park', async () => {
    const gate = new HttpApprovalGate();

    await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(isDeferrable(gate)).toBe(true);
    expect(gate.isPending('call_1')).toBe(true);
  });

  it('approves the next call to a tool that was approved by name', async () => {
    const gate = new HttpApprovalGate([], ['create_branch']);

    const allowed = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(allowed).toBe(true);
  });

  it('consumes a tool-name approval so it cannot authorise twice', async () => {
    const gate = new HttpApprovalGate([], ['create_branch']);

    const first = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });
    const second = await gate.request({
      approval: APPROVAL,
      requestId: 'call_2',
      fallback: async () => false,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('records the decision in the audit trail', async () => {
    const audit = new RecordingAudit();
    const gate = new HttpApprovalGate(['call_1'], [], audit);

    await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.decision).toBe('approved');
    expect(audit.entries[0]?.source).toBe('http');
  });
});

describe('ElicitationApprovalGate', () => {
  /** A stub client that answers the elicitation. */
  function stubClient(
    answer: { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> },
  ): { client: ElicitationCapable; calls: number } {
    const state = { calls: 0 };
    return {
      calls: 0,
      client: {
        async elicitInput() {
          state.calls += 1;
          return answer;
        },
      },
    };
  }

  it('runs the tool when the client accepts with confirm: true', async () => {
    const client: ElicitationCapable = {
      async elicitInput() {
        return { action: 'accept', content: { confirm: true } };
      },
    };
    const gate = new ElicitationApprovalGate(client);

    const allowed = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(allowed).toBe(true);
  });

  it('refuses when the client declines', async () => {
    const client: ElicitationCapable = {
      async elicitInput() {
        return { action: 'decline' };
      },
    };
    const gate = new ElicitationApprovalGate(client);

    const allowed = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(allowed).toBe(false);
  });

  it('refuses when the client accepts but does not confirm', async () => {
    const client: ElicitationCapable = {
      async elicitInput() {
        return { action: 'accept', content: { confirm: false } };
      },
    };
    const gate = new ElicitationApprovalGate(client);

    const allowed = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(allowed).toBe(false);
  });

  it('falls back to the HTTP path when the client cannot be asked', async () => {
    const client: ElicitationCapable = {
      async elicitInput() {
        throw new Error('Client does not support form elicitation.');
      },
    };
    const audit = new RecordingAudit();
    const gate = new ElicitationApprovalGate(client, audit);

    const allowed = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => true,
    });

    expect(allowed).toBe(true);
    // The failure and the fallback are both recorded.
    expect(audit.entries.map((e) => e.source)).toEqual(['elicitation', 'fallback']);
    expect(audit.entries[1]?.decision).toBe('approved');
  });

  it('times out and falls back when the client never answers', async () => {
    const client: ElicitationCapable = {
      async elicitInput() {
        // Never resolves.
        return new Promise(() => undefined);
      },
    };
    const audit = new RecordingAudit();
    const gate = new ElicitationApprovalGate(client, audit, 20);

    const allowed = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => false,
    });

    expect(allowed).toBe(false);
    expect(audit.entries[0]?.decision).toBe('timed_out');
  });
});

describe('DenyAllApprovalGate', () => {
  it('refuses every request', async () => {
    const gate = new DenyAllApprovalGate();

    const allowed = await gate.request({
      approval: APPROVAL,
      requestId: 'call_1',
      fallback: async () => true,
    });

    expect(allowed).toBe(false);
  });
});

describe('The agent and the approval gate', () => {
  it('does not run a destructive tool without approval', async () => {
    const provider = new BranchProvider();
    const registry = new ToolRegistry().registerAll(createTools());
    const agent = new Agent({
      provider,
      registry,
      systemPrompt: 'test',
      // Nothing approved: the run must park instead of running the tool.
      approvalGate: new HttpApprovalGate(),
    });

    const result = await agent.run({
      history: [],
      userMessage: 'create a branch',
    });

    expect(result.awaitingConfirmation).toBe(true);
    expect(result.pendingCall?.name).toBe('create_branch');

    // The tool did not run: no tool result was produced.
    expect(result.events.some((e) => e.type === 'tool_result')).toBe(false);
  });

  it('runs a destructive tool once the gate approves it', async () => {
    const provider = new BranchProvider();
    const registry = new ToolRegistry().registerAll(createTools());
    const agent = new Agent({
      provider,
      registry,
      systemPrompt: 'test',
      approvalGate: new HttpApprovalGate(['call_branch']),
    });

    const result = await agent.run({
      history: [],
      userMessage: 'create a branch',
    });

    expect(result.awaitingConfirmation).toBe(false);
    const toolResult = result.events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.result.summary).toContain('Created branch');
    }
  });

  it('never runs a destructive tool through a gate that refuses', async () => {
    const provider = new BranchProvider();
    const registry = new ToolRegistry().registerAll(createTools());
    const agent = new Agent({
      provider,
      registry,
      systemPrompt: 'test',
      approvalGate: new DenyAllApprovalGate(),
    });

    const result = await agent.run({
      history: [],
      userMessage: 'create a branch',
    });

    // The refusal is reported to the model, and the tool did not run.
    expect(result.events.some((e) => e.type === 'tool_result')).toBe(false);
    const error = result.events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
  });

  it('runs a destructive tool through the elicitation gate', async () => {
    const provider = new BranchProvider();
    const registry = new ToolRegistry().registerAll(createTools());
    const client: ElicitationCapable = {
      async elicitInput() {
        return { action: 'accept', content: { confirm: true } };
      },
    };

    const agent = new Agent({
      provider,
      registry,
      systemPrompt: 'test',
      approvalGate: new ElicitationApprovalGate(client),
    });

    const result = await agent.run({
      history: [],
      userMessage: 'create a branch',
    });

    expect(result.awaitingConfirmation).toBe(false);
    const toolResult = result.events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();

    // The approval decision is in the event stream, labelled with the
    // path that produced it.
    const decision = result.events.find((e) => e.type === 'approval_decision');
    expect(decision).toBeDefined();
    if (decision?.type === 'approval_decision') {
      expect(decision.approved).toBe(true);
      expect(decision.source).toBe('elicitation');
    }
  });
});

describe('noopApprovalAudit', () => {
  it('accepts a record without doing anything', () => {
    expect(() =>
      noopApprovalAudit.record({
        requestId: 'call_1',
        toolName: 'create_branch',
        decision: 'approved',
        source: 'http',
        at: new Date().toISOString(),
      }),
    ).not.toThrow();
  });
});
