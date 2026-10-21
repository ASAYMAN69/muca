import { describe, expect, it } from 'vitest';

import { Agent } from '../src/ai/agent.js';
import type {
  AIProvider,
  ProviderMessage,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
} from '../src/ai/provider.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';

/**
 * A scripted provider. Each entry is the response returned for one
 * chat() call, so a test can describe the exact conversation the model has.
 */
class ScriptedProvider implements AIProvider {
  readonly name = 'scripted';
  readonly receivedTools: ProviderTool[][] = [];
  readonly receivedMessages: ProviderMessage[][] = [];

  constructor(private readonly script: ProviderResponse[]) {}

  async chat(input: {
    messages: ProviderMessage[];
    tools: ProviderTool[];
  }): Promise<ProviderResponse> {
    this.receivedTools.push(input.tools);
    this.receivedMessages.push(input.messages);
    const next = this.script.shift();
    if (!next) {
      throw new Error('ScriptedProvider ran out of scripted responses');
    }
    return next;
  }
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): ProviderToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function text(content: string): ProviderResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

function withToolCalls(
  content: string | null,
  calls: ProviderToolCall[],
): ProviderResponse {
  return { content, toolCalls: calls, finishReason: 'tool_calls' };
}

function makeAgent(script: ProviderResponse[]) {
  const provider = new ScriptedProvider(script);
  const registry = new ToolRegistry().registerAll(createTools());
  const agent = new Agent({
    provider,
    registry,
    systemPrompt: 'You are Muca.',
  });
  return { agent, provider, registry };
}

describe('Agent tool-calling loop', () => {
  it('answers directly when no tool is needed', async () => {
    const { agent } = makeAgent([text('Hello! How can I help?')]);

    const result = await agent.run({ history: [], userMessage: 'hi' });

    expect(result.text).toBe('Hello! How can I help?');
    expect(result.awaitingConfirmation).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toEqual({ type: 'text', text: 'Hello! How can I help?' });
  });

  it('calls a tool, feeds the result back, and produces a final answer', async () => {
    const { agent, provider } = makeAgent([
      withToolCalls(null, [toolCall('call_1', 'echo', { message: 'ping' })]),
      text('The tool said ping.'),
    ]);

    const result = await agent.run({ history: [], userMessage: 'echo ping' });

    expect(result.text).toBe('The tool said ping.');
    expect(result.awaitingConfirmation).toBe(false);

    // Two rounds: one that requested the tool, one that answered.
    expect(provider.receivedTools).toHaveLength(2);

    // The tool catalogue was offered to the model.
    const catalogue = provider.receivedTools[0].map((t) => t.name);
    expect(catalogue).toContain('echo');
    expect(catalogue).toContain('list_deployments');

    // The second round must include the tool result.
    const secondRound = provider.receivedMessages[1];
    const toolMessage = secondRound.find((m) => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage!.content).toBe('ping');

    const toolResultEvent = result.events.find((e) => e.type === 'tool_result');
    expect(toolResultEvent).toBeDefined();
  });

  it('reports a validation failure instead of crashing', async () => {
    const { agent } = makeAgent([
      // `message` is required, so this must be rejected by the Zod schema.
      withToolCalls(null, [toolCall('call_1', 'echo', { repeat: 3 })]),
      text('I could not use that tool because the arguments were invalid.'),
    ]);

    const result = await agent.run({ history: [], userMessage: 'echo' });

    expect(result.text).toContain('invalid');
    const errorEvent = result.events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('reports an unknown tool without throwing', async () => {
    const { agent } = makeAgent([
      withToolCalls(null, [toolCall('call_1', 'nope_not_a_tool', {})]),
      text('That tool does not exist.'),
    ]);

    const result = await agent.run({ history: [], userMessage: 'do something' });

    expect(result.text).toBe('That tool does not exist.');
    const errorEvent = result.events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message).toContain('Unknown tool');
    }
  });

  it('pauses for confirmation on a destructive tool and does not run it', async () => {
    const { agent, provider } = makeAgent([
      withToolCalls(
        'I will create that branch.',
        [
          toolCall('call_branch', 'create_branch', {
            name: 'fix/checkout-rounding',
            baseBranch: 'main',
          }),
        ],
      ),
    ]);

    const result = await agent.run({ history: [], userMessage: 'create a branch' });

    expect(result.awaitingConfirmation).toBe(true);
    expect(result.pendingCall).not.toBeNull();
    expect(result.pendingCall!.name).toBe('create_branch');
    expect(result.pendingCall!.callId).toBe('call_branch');

    // The loop stopped before executing the tool.
    expect(provider.receivedMessages).toHaveLength(1);
    const toolMessage = provider.receivedMessages[0].find((m) => m.role === 'tool');
    expect(toolMessage).toBeUndefined();
  });

  it('executes a destructive tool once the call id is approved', async () => {
    const { agent } = makeAgent([
      withToolCalls(
        null,
        [
          toolCall('call_branch', 'create_branch', {
            name: 'fix/checkout-rounding',
            baseBranch: 'main',
          }),
        ],
      ),
      text('Created.'),
    ]);

    const result = await agent.run({
      history: [],
      userMessage: 'create a branch',
      approvedCallIds: ['call_branch'],
    });

    expect(result.awaitingConfirmation).toBe(false);
    const toolResult = result.events.find((e) => e.type === 'tool_result');
    expect(toolResult).toBeDefined();
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.result.summary).toContain('Created branch');
    }
  });

  it('stops after the maximum number of rounds', async () => {
    const script = Array.from({ length: 12 }, () =>
      withToolCalls(null, [toolCall('call_x', 'echo', { message: 'loop' })]),
    );
    const { agent } = makeAgent(script);

    const result = await agent.run({ history: [], userMessage: 'loop forever' });

    const errorEvent = result.events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message).toContain('maximum');
    }
  });

  it('returns an error event when the provider throws', async () => {
    const provider: AIProvider = {
      name: 'broken',
      chat: async () => {
        throw new Error('provider exploded');
      },
    };
    const registry = new ToolRegistry().registerAll(createTools());
    const agent = new Agent({ provider, registry, systemPrompt: 'x' });

    const result = await agent.run({ history: [], userMessage: 'hello' });

    expect(result.text).toBe('');
    const errorEvent = result.events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.message).toContain('provider exploded');
    }
  });
});
