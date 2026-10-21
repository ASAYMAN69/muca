import { describe, expect, it } from 'vitest';

import { Agent } from '../src/ai/agent.js';
import type {
  AIProvider,
  ProviderResponse,
  ProviderToolCall,
} from '../src/ai/provider.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { HttpApprovalGate } from '../src/ai/approval-gate.js';
import { PendingApprovalRegistry } from '../src/store/pending-approvals.js';

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

/**
 * The HTTP approval path must bind to the **action the user saw**, not just
 * to the tool name.
 *
 * The model produces a fresh call id on every turn, so the approval cannot
 * be matched by call id alone — the registry maps the parked call id back to
 * the tool. But the tool name alone is not enough either: the user approved
 * `create_branch(name="feature/approved")`, and the model may then ask for
 * `create_branch(name="something-else")`. Running that would execute an
 * action the user never approved.
 *
 * So the approval must also match the **arguments** that were parked.
 */
describe('HTTP approval binds to the parked action, not just the tool name', () => {
  function buildAgent(rounds: ProviderToolCall[][]) {
    const registry = new ToolRegistry().registerAll(createTools());
    const agent = new Agent({
      provider: new ScriptedProvider(rounds),
      registry,
      systemPrompt: 'test',
    });
    return { agent, registry };
  }

  it('does NOT approve a call whose arguments differ from the parked ones', async () => {
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

    // Turn 1: nothing approved. The run must park on the call.
    const first = await agent.run({
      history: [],
      userMessage: 'create a branch called feature/approved',
      approvalGate: new HttpApprovalGate([], []),
    });

    expect(first.awaitingConfirmation).toBe(true);
    expect(first.pendingCall).not.toBeNull();
    expect(first.pendingCall!.arguments).toEqual({ name: 'feature/approved' });

    pending.add({
      callId: first.pendingCall!.callId,
      toolName: first.pendingCall!.name,
      arguments: first.pendingCall!.arguments,
      at: new Date().toISOString(),
    });

    // Turn 2: the user approves the parked call. The model asks for a
    // DIFFERENT branch this time.
    const approvedCallIds = [first.pendingCall!.callId];
    const approvedToolNames = approvedCallIds
      .map((id) => pending.get(id)?.toolName)
      .filter((name): name is string => Boolean(name));

    const second = await agent.run({
      history: [],
      userMessage: 'yes, go ahead',
      approvalGate: new HttpApprovalGate(approvedCallIds, approvedToolNames),
      approvedCallIds,
    });

    const decision = second.events.find((e) => e.type === 'approval_decision');
    expect(decision).toBeDefined();

    // The differently-parameterised call must NOT have been approved.
    if (decision?.type === 'approval_decision') {
      expect(decision.approved).toBe(false);
    }

    // And it must not have produced a tool result for the other branch.
    const toolResult = second.events.find((e) => e.type === 'tool_result');
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.result.summary).not.toContain('attacker-controlled');
    }
  });

  it('DOES approve a call whose arguments match the parked ones', async () => {
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

    const first = await agent.run({
      history: [],
      userMessage: 'create a branch called feature/approved',
      approvalGate: new HttpApprovalGate([], []),
    });

    expect(first.awaitingConfirmation).toBe(true);

    pending.add({
      callId: first.pendingCall!.callId,
      toolName: first.pendingCall!.name,
      arguments: first.pendingCall!.arguments,
      at: new Date().toISOString(),
    });

    const approvedCallIds = [first.pendingCall!.callId];
    const approvedToolNames = approvedCallIds
      .map((id) => pending.get(id)?.toolName)
      .filter((name): name is string => Boolean(name));

    const second = await agent.run({
      history: [],
      userMessage: 'yes, go ahead',
      approvalGate: new HttpApprovalGate(approvedCallIds, approvedToolNames),
      approvedCallIds,
    });

    const decision = second.events.find((e) => e.type === 'approval_decision');
    expect(decision).toBeDefined();
    if (decision?.type === 'approval_decision') {
      expect(decision.approved).toBe(true);
    }
  });
});
