import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { parseSse, readSseEvents } from '../src/ai/sse.js';
import {
  AnthropicProvider,
  type FetchLike,
  type FetchLikeResponse,
} from '../src/ai/anthropic-provider.js';
import {
  GeminiProvider,
  type FetchLike as GeminiFetchLike,
} from '../src/ai/gemini-provider.js';
import { OpenAIProvider } from '../src/ai/openai-provider.js';
import type { ProviderStreamEvent } from '../src/ai/stream.js';

/**
 * Provider streaming.
 *
 * The user wants to watch the model think, so the tokens have to arrive
 * as they are produced — not in one lump at the end.
 */
describe('the SSE parser', () => {
  it('reads the events out of a stream', async () => {
    const stream = toBytes([
      'event: message_start\n',
      'data: {"type":"message_start"}\n',
      '\n',
      'data: {"type":"message_stop"}\n',
      '\n',
    ]);

    const events = [];
    for await (const event of readSseEvents(stream)) events.push(event);

    expect(events).toHaveLength(2);
    expect(events[0]?.event).toBe('message_start');
    expect(events[0]?.data).toBe('{"type":"message_start"}');
    expect(events[1]?.data).toBe('{"type":"message_stop"}');
  });

  it('copes with a line that is split across two chunks', async () => {
    const stream = toBytes(['data: {"a":', '1}\n\n']);

    const events = [];
    for await (const event of parseSse(stream)) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('{"a":1}');
  });

  it('ignores comments and blank lines', async () => {
    const stream = toBytes([': a comment\n', '\n', 'data: real\n', '\n']);

    const events = [];
    for await (const event of parseSse(stream)) events.push(event);

    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('real');
  });
});

/** Turns text into a byte stream, one chunk per entry. */
function toBytes(chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder();
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield encoder.encode(chunk);
      }
    },
  };
}

describe('the Anthropic streaming adapter', () => {
  it('reports the text, the thinking and the tool call', async () => {
    const events: ProviderStreamEvent[] = [];
    const calls: unknown[] = [];

    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => '',
      body: toBytes([
        'event: message_start\ndata: {"type":"message_start"}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" there"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"hmm"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"create_branch","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"name\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"fix/x\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    });

    const provider = new AnthropicProvider({
      apiKey: 'k',
      endpoint: 'https://anthropic.test',
      model: 'claude-x',
      fetchImpl,
    });

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'hi' }], tools: [] },
      (event) => {
        events.push(event);
        if (event.type === 'tool_call') calls.push(event.call);
      },
    );

    expect(events.map((e) => e.type)).toEqual([
      'message_delta',
      'message_delta',
      'thinking_delta',
      'tool_call',
    ]);
    expect(response.content).toBe('Hello there');
    expect(response.finishReason).toBe('tool_calls');
    expect(calls).toHaveLength(1);
    expect((calls[0] as { id: string }).id).toBe('toolu_1');
    expect(JSON.parse((calls[0] as { arguments: string }).arguments)).toEqual({
      name: 'fix/x',
    });
  });

  it('falls back to one call when the provider will not stream', async () => {
    const events: ProviderStreamEvent[] = [];

    const fetchImpl: FetchLike = async (_url, init) => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: 'All at once' }],
        stop_reason: 'end_turn',
      }),
      text: async () => '',
      body: null,
    });

    const provider = new AnthropicProvider({
      apiKey: 'k',
      endpoint: 'https://anthropic.test',
      model: 'claude-x',
      fetchImpl,
    });

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'hi' }], tools: [] },
      (event) => events.push(event),
    );

    expect(response.content).toBe('All at once');
    expect(events).toEqual([{ type: 'message_delta', text: 'All at once' }]);
  });

  it('sends the cache breakpoints when the cache is on', async () => {
    const bodies: string[] = [];

    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [] }),
        text: async () => '',
        body: null,
      };
    };

    const provider = new AnthropicProvider({
      apiKey: 'k',
      endpoint: 'https://anthropic.test',
      model: 'claude-x',
      fetchImpl,
      cache: true,
    });

    await provider.chat({
      messages: [
        { role: 'system', content: 'You are Muca.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [],
    });

    const body = JSON.parse(bodies[0]!) as {
      system: Array<{ type: string; text: string; cache_control: { type: string } }>;
      messages: Array<{ content: Array<{ cache_control?: { type: string } }> }>;
    };

    expect(body.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages[0]?.content[0]?.cache_control).toEqual({
      type: 'ephemeral',
    });
  });

  it('leaves the request alone when the cache is off', async () => {
    const bodies: string[] = [];

    const fetchImpl: FetchLike = async (_url, init) => {
      bodies.push(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [] }),
        text: async () => '',
        body: null,
      };
    };

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

    const body = JSON.parse(bodies[0]!) as { system: string };
    expect(body.system).toBe('You are Muca.');
  });
});

describe('the Gemini streaming adapter', () => {
  it('reports the text and the tool call', async () => {
    const events: ProviderStreamEvent[] = [];
    let url = '';

    const fetchImpl: GeminiFetchLike = async (requestUrl) => {
      url = requestUrl;
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
        body: toBytes([
          'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\n\n',
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"echo","args":{"message":"hi"}}}]},"finishReason":"STOP"}]}\n\n',
        ]),
      };
    };

    const provider = new GeminiProvider({
      apiKey: 'k',
      endpoint: 'https://gemini.test/v1beta',
      model: 'gemini-2.5-flash',
      fetchImpl,
    });

    const response = await provider.chatStream(
      { messages: [{ role: 'user', content: 'hi' }], tools: [] },
      (event) => events.push(event),
    );

    expect(url).toContain(':streamGenerateContent?alt=sse');
    expect(events[0]).toEqual({ type: 'message_delta', text: 'Hello' });
    expect(events[1]?.type).toBe('tool_call');
    expect(response.content).toBe('Hello');
    expect(response.toolCalls[0]?.name).toBe('echo');
  });
});

describe('the OpenAI streaming adapter', () => {
  it('reports the text and the tool call', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}\n\n',
      );
      res.write(
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"echo","arguments":""}}]},"finish_reason":null}]}\n\n',
      );
      res.write(
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"message\\":\\"hi\\"}"}}]},"finish_reason":null}]}\n\n',
      );
      res.write(
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const events: ProviderStreamEvent[] = [];
      const provider = new OpenAIProvider({
        apiKey: 'k',
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: 'gpt-x',
      });

      const response = await provider.chatStream(
        { messages: [{ role: 'user', content: 'hi' }], tools: [] },
        (event) => events.push(event),
      );

      expect(events[0]).toEqual({ type: 'message_delta', text: 'Hello' });
      expect(events[1]?.type).toBe('tool_call');
      expect(response.content).toBe('Hello');
      expect(response.toolCalls[0]?.id).toBe('call_1');
      expect(response.toolCalls[0]?.name).toBe('echo');
      expect(JSON.parse(response.toolCalls[0]?.arguments ?? '{}')).toEqual({
        message: 'hi',
      });
      expect(response.finishReason).toBe('tool_calls');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

/** The shape the Anthropic adapter needs, re-exported for the tests. */
export type { FetchLikeResponse };
