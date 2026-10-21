import { describe, expect, it } from 'vitest';

import {
  BedrockProvider,
  fromBedrockResponse,
  toBedrockMessages,
  toToolConfig,
  toolResultText,
  extractToolResults,
  type BedrockClientLike,
} from '../src/ai/bedrock-provider.js';
import type { ProviderMessage, ProviderTool } from '../src/ai/provider.js';

/* -------------------------------------------------------------------------- */
/* A stubbed Bedrock client                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A stub of `BedrockRuntimeClient`.
 *
 * It records the command it was given and returns a canned response, so
 * the mapping can be tested without a single AWS call.
 */
class StubBedrockClient implements BedrockClientLike {
  readonly commands: unknown[] = [];
  private response: unknown;

  constructor(response: unknown) {
    this.response = response;
  }

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    return this.response;
  }

  /** The input the command was built with. */
  get input(): {
    modelId?: string;
    messages?: unknown[];
    toolConfig?: { tools: unknown[] };
  } {
    return (this.commands[0] as { input: Record<string, never> }).input as {
      modelId?: string;
      messages?: unknown[];
      toolConfig?: { tools: unknown[] };
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('BedrockProvider message mapping', () => {
  it('maps a system message out of the message list', () => {
    const messages = toBedrockMessages([
      { role: 'system', content: 'You are Muca.' },
      { role: 'user', content: 'hello' },
    ]);

    // Bedrock has no `system` role inside `messages`; the system prompt
    // goes in a separate field on the request.
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('maps a user message to a text content block', () => {
    const messages = toBedrockMessages([
      { role: 'user', content: 'why did the deploy fail?' },
    ]);

    expect(messages[0]).toEqual({
      role: 'user',
      content: [{ text: 'why did the deploy fail?' }],
    });
  });

  it('maps an assistant message with tool calls to toolUse blocks', () => {
    const messages = toBedrockMessages([
      {
        role: 'assistant',
        content: 'I will create that branch.',
        toolCalls: [
          {
            id: 'tool_1',
            name: 'create_branch',
            arguments: JSON.stringify({ name: 'fix/x', baseBranch: 'main' }),
          },
        ],
      },
    ]);

    const content = messages[0]?.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(content[0]).toEqual({ text: 'I will create that branch.' });
    expect(content[1]).toEqual({
      toolUse: {
        toolUseId: 'tool_1',
        name: 'create_branch',
        input: { name: 'fix/x', baseBranch: 'main' },
      },
    });
  });

  it('maps a tool result message to a toolResult block', () => {
    const messages = toBedrockMessages([
      {
        role: 'tool',
        content: 'Created branch "fix/x".',
        toolCallId: 'tool_1',
        name: 'create_branch',
      },
    ]);

    expect(messages[0]?.role).toBe('user');
    const content = messages[0]?.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(content[0]).toEqual({
      toolResult: {
        toolUseId: 'tool_1',
        content: [{ text: 'Created branch "fix/x".' }],
      },
    });
  });

  it('treats invalid tool arguments as an empty object rather than throwing', () => {
    const messages = toBedrockMessages([
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          { id: 'tool_1', name: 'create_branch', arguments: '{not json' },
        ],
      },
    ]);

    const content = messages[0]?.content as unknown as Array<
      Record<string, unknown>
    >;
    expect(content[0]).toEqual({
      toolUse: { toolUseId: 'tool_1', name: 'create_branch', input: {} },
    });
  });
});

describe('BedrockProvider tool mapping', () => {
  const tools: ProviderTool[] = [
    {
      name: 'list_deployments',
      description: 'List recent deployments.',
      parameters: {
        type: 'object',
        properties: { service: { type: 'string' } },
      },
    },
  ];

  it('maps the tool catalogue onto Bedrock toolConfig', () => {
    const config = toToolConfig(tools);

    expect(config.tools).toHaveLength(1);
    const spec = config.tools?.[0]?.toolSpec;
    expect(spec?.name).toBe('list_deployments');
    expect(spec?.description).toBe('List recent deployments.');
    expect(spec?.inputSchema?.json).toEqual(tools[0]?.parameters);
  });

  it('sends the toolConfig with the request', async () => {
    const client = new StubBedrockClient({
      output: { message: { content: [{ text: 'done' }] } },
      stopReason: 'end_turn',
    });
    const provider = new BedrockProvider({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      region: 'us-east-1',
      client,
    });

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], tools });

    expect(client.input.toolConfig?.tools).toHaveLength(1);
  });
});

describe('BedrockProvider response mapping', () => {
  it('maps a text response', () => {
    const response = fromBedrockResponse({
      output: { message: { content: [{ text: 'The deploy failed.' }] } },
      stopReason: 'end_turn',
    });

    expect(response.content).toBe('The deploy failed.');
    expect(response.toolCalls).toEqual([]);
    expect(response.finishReason).toBe('stop');
  });

  it('maps a toolUse response to tool calls', () => {
    const response = fromBedrockResponse({
      output: {
        message: {
          content: [
            { text: 'Creating the branch.' },
            {
              toolUse: {
                toolUseId: 'tool_9',
                name: 'create_branch',
                input: { name: 'fix/x', baseBranch: 'main' },
              },
            },
          ],
        },
      },
      stopReason: 'tool_use',
    });

    expect(response.content).toBe('Creating the branch.');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.id).toBe('tool_9');
    expect(response.toolCalls[0]?.name).toBe('create_branch');
    expect(JSON.parse(response.toolCalls[0]?.arguments ?? '{}')).toEqual({
      name: 'fix/x',
      baseBranch: 'main',
    });
    expect(response.finishReason).toBe('tool_calls');
  });

  it('maps the stop reasons', () => {
    expect(
      fromBedrockResponse({ stopReason: 'max_tokens' }).finishReason,
    ).toBe('length');
    expect(
      fromBedrockResponse({ stopReason: 'content_filtered' }).finishReason,
    ).toBe('content_filter');
    expect(fromBedrockResponse({ stopReason: 'end_turn' }).finishReason).toBe(
      'stop',
    );
    expect(fromBedrockResponse({}).finishReason).toBe('unknown');
  });

  it('survives an empty response', () => {
    const response = fromBedrockResponse(undefined);
    expect(response.content).toBeNull();
    expect(response.toolCalls).toEqual([]);
  });
});

describe('BedrockProvider round trip', () => {
  it('sends the model id from the options and returns the parsed answer', async () => {
    const client = new StubBedrockClient({
      output: {
        message: {
          content: [
            {
              toolUse: {
                toolUseId: 'tool_1',
                name: 'list_deployments',
                input: { service: 'checkout-api' },
              },
            },
          ],
        },
      },
      stopReason: 'tool_use',
    });

    const provider = new BedrockProvider({
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      region: 'eu-west-1',
      client,
    });

    const response = await provider.chat({
      messages: [
        { role: 'system', content: 'You are Muca.' },
        { role: 'user', content: 'what failed?' },
      ],
      tools: [],
    });

    // The model id is never hardcoded: it comes from the options.
    expect(client.input.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    expect(response.toolCalls[0]?.name).toBe('list_deployments');
    expect(provider.name).toBe('bedrock');
  });

  it('round-trips a full tool-calling turn', async () => {
    const client = new StubBedrockClient({
      output: {
        message: {
          content: [
            {
              toolUse: {
                toolUseId: 'tool_1',
                name: 'create_branch',
                input: { name: 'fix/x' },
              },
            },
          ],
        },
      },
      stopReason: 'tool_use',
    });

    const provider = new BedrockProvider({
      model: 'a-model-id',
      region: 'us-east-1',
      client,
    });

    const history: ProviderMessage[] = [
      { role: 'system', content: 'You are Muca.' },
      { role: 'user', content: 'create a branch' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'tool_1',
            name: 'create_branch',
            arguments: JSON.stringify({ name: 'fix/x' }),
          },
        ],
      },
      {
        role: 'tool',
        content: 'Created branch "fix/x".',
        toolCallId: 'tool_1',
        name: 'create_branch',
      },
    ];

    await provider.chat({ messages: history, tools: [] });

    // The assistant turn became a toolUse block and the tool turn became
    // a toolResult block.
    const sent = client.input.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;

    expect(sent).toHaveLength(3);
    expect(sent[1]?.content[0]).toEqual({
      toolUse: { toolUseId: 'tool_1', name: 'create_branch', input: { name: 'fix/x' } },
    });
    expect(sent[2]?.content[0]).toEqual({
      toolResult: {
        toolUseId: 'tool_1',
        content: [{ text: 'Created branch "fix/x".' }],
      },
    });
  });
});

describe('Bedrock tool result helpers', () => {
  it('extracts the tool result blocks', () => {
    const blocks = extractToolResults([
      { text: 'hello' },
      { toolResult: { toolUseId: 'tool_1', content: [{ text: 'ok' }] } },
    ]);

    expect(blocks).toHaveLength(1);
    expect(toolResultText(blocks[0]!)).toBe('ok');
  });
});
