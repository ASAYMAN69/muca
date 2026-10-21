import { describe, expect, it } from 'vitest';

import {
  AnthropicProvider,
  fromAnthropicResponse,
  splitSystem as splitAnthropicSystem,
  toAnthropicTools,
  type FetchLike,
} from '../src/ai/anthropic-provider.js';
import {
  GeminiProvider,
  splitSystem as splitGeminiSystem,
  toGeminiTools,
  type FetchLike as GeminiFetchLike,
} from '../src/ai/gemini-provider.js';
import type { ProviderMessage } from '../src/ai/provider.js';

/**
 * The Anthropic and Gemini adapters.
 *
 * Every test is **offline**: the fetch is injected, so no endpoint is
 * ever contacted.
 */

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A fetch that records the request and returns a canned response. */
function recordingFetch(
  response: unknown,
): { fetchImpl: FetchLike; calls: Array<{ url: string; body: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body, headers: init.headers });
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  };
  return { fetchImpl, calls };
}

/* -------------------------------------------------------------------------- */
/* Anthropic                                                                  */
/* -------------------------------------------------------------------------- */

describe('the Anthropic adapter', () => {
  it('sends the system prompt as a top-level field', async () => {
    const { fetchImpl, calls } = recordingFetch({
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
    });

    const provider = new AnthropicProvider({
      apiKey: 'k',
      endpoint: 'https://anthropic.test',
      model: 'claude-x',
      fetchImpl,
    });

    await provider.chat({
      messages: [
        { role: 'system', content: 'You are Muca.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [],
    });

    const body = JSON.parse(calls[0]!.body);
    expect(body.system).toBe('You are Muca.');
    // And it is not a message.
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ]);
  });

  it('sends the key in a header, never in the URL', async () => {
    const { fetchImpl, calls } = recordingFetch({ content: [] });

    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-secret',
      endpoint: 'https://anthropic.test',
      model: 'claude-x',
      fetchImpl,
    });

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });

    expect(calls[0]!.url).toBe('https://anthropic.test/v1/messages');
    expect(calls[0]!.url).not.toContain('sk-ant-secret');
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-secret');
  });

  it('maps an assistant tool call to a tool_use block', async () => {
    const { fetchImpl, calls } = recordingFetch({ content: [] });

    const provider = new AnthropicProvider({
      apiKey: 'k',
      endpoint: 'https://anthropic.test',
      model: 'claude-x',
      fetchImpl,
    });

    await provider.chat({
      messages: [
        { role: 'assistant', content: 'Creating.', toolCalls: [
          { id: 'tu_1', name: 'create_branch', arguments: '{"name":"fix/x"}' },
        ] },
      ],
      tools: [],
    });

    const body = JSON.parse(calls[0]!.body);
    expect(body.messages[0].content[1]).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'create_branch',
      input: { name: 'fix/x' },
    });
  });

  it('maps a tool result to a tool_result block', async () => {
    const { fetchImpl, calls } = recordingFetch({ content: [] });

    const provider = new AnthropicProvider({
      apiKey: 'k',
      endpoint: 'https://anthropic.test',
      model: 'claude-x',
      fetchImpl,
    });

    await provider.chat({
      messages: [
        { role: 'tool', content: 'Created.', toolCallId: 'tu_1', name: 'create_branch' },
      ],
      tools: [],
    });

    const body = JSON.parse(calls[0]!.body);
    expect(body.messages[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: 'Created.',
    });
  });

  it('extracts tool calls from the response', () => {
    const response = fromAnthropicResponse({
      content: [
        { type: 'text', text: 'Creating.' },
        { type: 'tool_use', id: 'tu_1', name: 'create_branch', input: { name: 'fix/x' } },
      ],
      stop_reason: 'tool_use',
    });

    expect(response.content).toBe('Creating.');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]?.id).toBe('tu_1');
    expect(response.toolCalls[0]?.name).toBe('create_branch');
    expect(JSON.parse(response.toolCalls[0]?.arguments ?? '{}')).toEqual({
      name: 'fix/x',
    });
    expect(response.finishReason).toBe('tool_calls');
  });

  it('maps the stop reasons', () => {
    expect(
      fromAnthropicResponse({ content: [], stop_reason: 'end_turn' }).finishReason,
    ).toBe('stop');
    expect(
      fromAnthropicResponse({ content: [], stop_reason: 'max_tokens' }).finishReason,
    ).toBe('length');
    expect(
      fromAnthropicResponse({ content: [], stop_reason: 'tool_use' }).finishReason,
    ).toBe('tool_calls');
    expect(fromAnthropicResponse({ content: [] }).finishReason).toBe('unknown');
  });

  it('publishes the tool catalogue', () => {
    const tools = toAnthropicTools([
      {
        name: 'list_deployments',
        description: 'List deployments.',
        parameters: { type: 'object', properties: {} },
      },
    ]);

    expect(tools[0]).toEqual({
      name: 'list_deployments',
      description: 'List deployments.',
      input_schema: { type: 'object', properties: {} },
    });
  });

  it('splits the system messages out', () => {
    const { system, messages } = splitAnthropicSystem([
      { role: 'system', content: 'A' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'hello' },
    ]);

    expect(system).toBe('A\n\nB');
    expect(messages).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Gemini                                                                     */
/* -------------------------------------------------------------------------- */

describe('the Gemini adapter', () => {
  it('sends the system prompt as systemInstruction', async () => {
    const { fetchImpl, calls } = recordingFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    });

    const provider = new GeminiProvider({
      apiKey: 'k',
      endpoint: 'https://gemini.test/v1beta',
      model: 'gemini-x',
      fetchImpl: fetchImpl as GeminiFetchLike,
    });

    await provider.chat({
      messages: [
        { role: 'system', content: 'You are Muca.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [],
    });

    const body = JSON.parse(calls[0]!.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are Muca.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hello' }] },
    ]);
  });

  it('sends the key in a header, never in the URL', async () => {
    const { fetchImpl, calls } = recordingFetch({ candidates: [] });

    const provider = new GeminiProvider({
      apiKey: 'AIza-secret',
      endpoint: 'https://gemini.test/v1beta',
      model: 'gemini-x',
      fetchImpl: fetchImpl as GeminiFetchLike,
    });

    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] });

    expect(calls[0]!.url).toBe(
      'https://gemini.test/v1beta/models/gemini-x:generateContent',
    );
    expect(calls[0]!.url).not.toContain('AIza-secret');
    expect(calls[0]!.headers['x-goog-api-key']).toBe('AIza-secret');
  });

  it('maps an assistant tool call to a functionCall part', async () => {
    const { fetchImpl, calls } = recordingFetch({ candidates: [] });

    const provider = new GeminiProvider({
      apiKey: 'k',
      endpoint: 'https://gemini.test/v1beta',
      model: 'gemini-x',
      fetchImpl: fetchImpl as GeminiFetchLike,
    });

    await provider.chat({
      messages: [
        { role: 'assistant', content: 'Creating.', toolCalls: [
          { id: 'call_1', name: 'create_branch', arguments: '{"name":"fix/x"}' },
        ] },
      ],
      tools: [],
    });

    const body = JSON.parse(calls[0]!.body);
    expect(body.contents[0].parts[1]).toEqual({
      functionCall: { name: 'create_branch', args: { name: 'fix/x' } },
    });
  });

  it('maps a tool result to a functionResponse part', async () => {
    const { fetchImpl, calls } = recordingFetch({ candidates: [] });

    const provider = new GeminiProvider({
      apiKey: 'k',
      endpoint: 'https://gemini.test/v1beta',
      model: 'gemini-x',
      fetchImpl: fetchImpl as GeminiFetchLike,
    });

    await provider.chat({
      messages: [
        { role: 'tool', content: 'Created.', toolCallId: 'call_1', name: 'create_branch' },
      ],
      tools: [],
    });

    const body = JSON.parse(calls[0]!.body);
    expect(body.contents[0].parts[0]).toEqual({
      functionResponse: { name: 'create_branch', response: { result: 'Created.' } },
    });
  });

  it('maps the finish reasons', () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      endpoint: 'https://gemini.test/v1beta',
      model: 'gemini-x',
    });

    expect(
      provider.fromGeminiResponse({ candidates: [{ finishReason: 'STOP' }] }).finishReason,
    ).toBe('stop');
    expect(
      provider.fromGeminiResponse({ candidates: [{ finishReason: 'MAX_TOKENS' }] })
        .finishReason,
    ).toBe('length');
    expect(
      provider.fromGeminiResponse({ candidates: [{ finishReason: 'SAFETY' }] })
        .finishReason,
    ).toBe('content_filter');
  });

  it('publishes the tool catalogue as function declarations', () => {
    const tools = toGeminiTools([
      {
        name: 'list_deployments',
        description: 'List deployments.',
        parameters: { type: 'object', properties: {} },
      },
    ]);

    expect(tools[0]).toEqual({
      functionDeclarations: [
        {
          name: 'list_deployments',
          description: 'List deployments.',
          parameters: { type: 'object', properties: {} },
        },
      ],
    });
  });

  /* ------------------------------------------------------------------ */
  /* The id-synthesis trap                                              */
  /* ------------------------------------------------------------------ */

  it('synthesises a unique id per call, even for the same tool', () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      endpoint: 'https://gemini.test/v1beta',
      model: 'gemini-x',
    });

    const response = provider.fromGeminiResponse({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'create_branch', args: { name: 'a' } } },
              { functionCall: { name: 'create_branch', args: { name: 'b' } } },
            ],
          },
        },
      ],
    });

    expect(response.toolCalls).toHaveLength(2);
    const [first, second] = response.toolCalls;

    // Two calls to the *same* tool must not share an id.
    expect(first!.id).not.toBe(second!.id);
    // The id must not be the tool name.
    expect(first!.id).not.toBe('create_branch');
    expect(second!.id).not.toBe('create_branch');

    // Each id maps back to its own call.
    expect(provider.callForId(first!.id)?.args).toEqual({ name: 'a' });
    expect(provider.callForId(second!.id)?.args).toEqual({ name: 'b' });
  });

  it('keeps the ids unique across turns', () => {
    const provider = new GeminiProvider({
      apiKey: 'k',
      endpoint: 'https://gemini.test/v1beta',
      model: 'gemini-x',
    });

    const first = provider.fromGeminiResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: 'create_branch' } }] } }],
    });
    const second = provider.fromGeminiResponse({
      candidates: [{ content: { parts: [{ functionCall: { name: 'create_branch' } }] } }],
    });

    expect(first.toolCalls[0]!.id).not.toBe(second.toolCalls[0]!.id);
  });

  /**
   * The end-to-end round trip the task calls out: a Gemini tool call must
   * survive the agent loop, including two calls to the same tool in one
   * turn. The agent matches a tool result back to its call **by id**, so
   * the ids must be unique.
   */
  it('survives a round trip through the agent loop', async () => {
    const { fetchImpl } = recordingFetch({
      candidates: [
        {
          content: {
            parts: [
              { functionCall: { name: 'create_branch', args: { name: 'a' } } },
              { functionCall: { name: 'create_branch', args: { name: 'b' } } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
    });

    const provider = new GeminiProvider({
      apiKey: 'k',
      endpoint: 'https://gemini.test/v1beta',
      model: 'gemini-x',
      fetchImpl: fetchImpl as GeminiFetchLike,
    });

    const response = await provider.chat({
      messages: [{ role: 'user', content: 'create two branches' }],
      tools: [],
    });

    const ids = response.toolCalls.map((call) => call.id);
    expect(new Set(ids).size).toBe(2);

    // Both calls are addressable, so the agent can send a result back
    // for each one.
    for (const id of ids) {
      expect(provider.callForId(id)).toBeDefined();
    }
  });

  it('splits the system messages out', () => {
    const { system, contents } = splitGeminiSystem([
      { role: 'system', content: 'A' },
      { role: 'user', content: 'hello' },
    ]);

    expect(system).toBe('A');
    expect(contents).toEqual([{ role: 'user', parts: [{ text: 'hello' }] }]);
  });
});

/* -------------------------------------------------------------------------- */
/* The neutral interface                                                      */
/* -------------------------------------------------------------------------- */

describe('the new adapters implement AIProvider', () => {
  it('exposes the provider name the health endpoint reports', () => {
    const anthropic = new AnthropicProvider({
      apiKey: 'k',
      endpoint: 'https://a.test',
      model: 'm',
    });
    const gemini = new GeminiProvider({
      apiKey: 'k',
      endpoint: 'https://g.test',
      model: 'm',
    });

    expect(anthropic.name).toBe('anthropic');
    expect(gemini.name).toBe('gemini');
  });

  it('keeps the conversation shape across the mapping', () => {
    const messages: ProviderMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1', toolCalls: [
        { id: 'c1', name: 't', arguments: '{"x":1}' },
      ] },
      { role: 'tool', content: 'r1', toolCallId: 'c1', name: 't' },
      { role: 'assistant', content: 'a2' },
    ];

    const anthropic = splitAnthropicSystem(messages);
    expect(anthropic.system).toBe('sys');
    expect(anthropic.messages).toHaveLength(4);
    expect(anthropic.messages[0]?.role).toBe('user');
    expect(anthropic.messages[1]?.role).toBe('assistant');
    expect(anthropic.messages[2]?.role).toBe('user');
    expect(anthropic.messages[3]?.role).toBe('assistant');

    const gemini = splitGeminiSystem(messages);
    expect(gemini.system).toBe('sys');
    expect(gemini.contents).toHaveLength(4);
    expect(gemini.contents[1]?.role).toBe('model');
  });
});
