import { describe, expect, it } from 'vitest';

import { Agent } from '../src/ai/agent.js';
import type {
  AIProvider,
  ProviderMessage,
  ProviderResponse,
  ProviderTool,
} from '../src/ai/provider.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';

/**
 * A provider that always asks for a tool, so the loop runs out of rounds.
 *
 * When it is called **without** tools — which is how the agent asks for a
 * final answer — it replies with a summary instead.
 */
class NeverStopsProvider implements AIProvider {
  readonly name = 'never-stops';
  private round = 0;

  async chat(input: {
    messages: ProviderMessage[];
    tools: ProviderTool[];
  }): Promise<ProviderResponse> {
    // The final call: no tools were offered.
    if (input.tools.length === 0) {
      return {
        content: 'Here is what I found: the deployment failed its health check.',
        toolCalls: [],
        finishReason: 'stop',
      };
    }

    this.round += 1;
    return {
      content: null,
      toolCalls: [
        {
          id: `call_${this.round}`,
          name: 'list_deployments',
          arguments: JSON.stringify({ service: 'checkout-api' }),
        },
      ],
      finishReason: 'tool_calls',
    };
  }
}

describe('the agent ends with an answer, not an error', () => {
  function buildAgent(provider: AIProvider, maxRounds: number) {
    return new Agent({
      provider,
      registry: new ToolRegistry().registerAll(createTools()),
      systemPrompt: 'test',
      maxRounds,
    });
  }

  it('summarises what it found when it runs out of rounds', async () => {
    const agent = buildAgent(new NeverStopsProvider(), 3);

    const result = await agent.run({
      history: [],
      userMessage: 'what broke?',
    });

    // The run hit the limit, but it still answered.
    expect(result.text).toContain('Here is what I found');
    expect(result.awaitingConfirmation).toBe(false);

    // The tool calls it did make are still reported.
    const results = result.events.filter((e) => e.type === 'tool_result');
    expect(results.length).toBe(3);

    // And it did not end with an error.
    const errors = result.events.filter((e) => e.type === 'error');
    expect(errors).toHaveLength(0);
  });

  it('still reports the limit when the provider cannot answer', async () => {
    const broken: AIProvider = {
      name: 'broken',
      async chat(): Promise<ProviderResponse> {
        throw new Error('provider is down');
      },
    };

    const agent = buildAgent(broken, 2);
    const result = await agent.run({ history: [], userMessage: 'what broke?' });

    expect(result.text).toBe('');
    const errors = result.events.filter((e) => e.type === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });
});
