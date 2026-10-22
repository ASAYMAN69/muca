import type {
  AIProvider,
  ProviderMessage,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
} from './provider.js';
import type { ProviderStreamSink } from './stream.js';
import { readSseEvents } from './sse.js';

/**
 * Anthropic Messages API adapter.
 *
 * The Messages API is the current Anthropic API. It maps onto Muca's
 * neutral `ProviderMessage` shape with one meaningful difference from
 * OpenAI: the system prompt is a **top-level** field, not a message.
 *
 *   | Muca                | Anthropic                          |
 *   |---------------------|------------------------------------|
 *   | `ProviderMessage`   | `Message` (system goes top-level)   |
 *   | `ProviderToolCall`  | `tool_use` content block            |
 *   | tool result message | `tool_result` content block         |
 *   | `ProviderTool`      | `tools[]`                          |
 *
 * The transport is the global `fetch` — no Anthropic SDK is used.
 */

/** The minimal shape of a `fetch` response the adapter needs. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /** The raw body, when the response is a stream. */
  body?: AsyncIterable<Uint8Array> | null;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

export interface AnthropicProviderOptions {
  apiKey: string;
  /** The Messages API base, e.g. `https://api.anthropic.com`. */
  endpoint: string;
  /** The model id. Required — Anthropic has no safe default. */
  model: string;
  /** Optional pre-built fetch (the tests inject one). */
  fetchImpl?: FetchLike;
  /** Optional max tokens. Defaults to 2048. */
  maxTokens?: number;
  /** The Anthropic API version header. */
  apiVersion?: string;
  /**
   * Turns on Anthropic's prompt cache.
   *
   * The cache needs `cache_control` on a content block, which means the
   * system prompt has to be sent as an **array** of blocks rather than a
   * string. That changes the shape of the request, so it is opt-in: the
   * plain request is unchanged, and the long-running live path turns it
   * on.
   */
  cache?: boolean;
}

/** Anthropic's stop reasons, mapped onto Muca's four. */
function mapStopReason(reason: string | undefined): ProviderResponse['finishReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    default:
      return 'unknown';
  }
}

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly apiVersion: string;
  private readonly fetchImpl: FetchLike;
  private readonly cache: boolean;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 2048;
    this.apiVersion = options.apiVersion ?? '2023-06-01';
    this.fetchImpl = options.fetchImpl ?? (defaultFetch as FetchLike);
    this.cache = options.cache ?? false;
  }

  async chat(input: {
    messages: ProviderMessage[];
    tools: ProviderTool[];
    temperature?: number;
  }): Promise<ProviderResponse> {
    const response = await this.fetchImpl(`${this.endpoint}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.requestBody(input)),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Anthropic request failed with status ${response.status}: ${sanitise(body)}`,
      );
    }

    const payload = (await response.json()) as AnthropicResponse;
    return fromAnthropicResponse(payload);
  }

  /**
   * Streams the reply.
   *
   * The Messages API streams server-sent events. The deltas are handed to
   * `onEvent` as they arrive; the returned response is the same shape the
   * non-streaming call returns, so the agent loop does not have to care
   * which one it used.
   *
   * A provider that will not stream is not a failure: the adapter falls
   * back to one non-streaming call and reports the text as a single
   * delta.
   */
  async chatStream(
    input: {
      messages: ProviderMessage[];
      tools: ProviderTool[];
      temperature?: number;
    },
    onEvent: ProviderStreamSink,
  ): Promise<ProviderResponse> {
    const response = await this.fetchImpl(`${this.endpoint}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...this.requestBody(input), stream: true }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Anthropic request failed with status ${response.status}: ${sanitise(body)}`,
      );
    }

    const stream = response.body;
    if (!stream) {
      // No stream: fall back to one call and report the text as a delta.
      const result = await this.chat(input);
      if (result.content) onEvent({ type: 'message_delta', text: result.content });
      return result;
    }

    return this.readStream(stream, onEvent);
  }

  /** The headers of every request. The key never appears in the URL. */
  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion,
    };
  }

  /** The body of a request, with or without the cache breakpoints. */
  private requestBody(input: {
    messages: ProviderMessage[];
    tools: ProviderTool[];
    temperature?: number;
  }): Record<string, unknown> {
    const { system, messages } = splitSystem(input.messages);

    return {
      model: this.model,
      max_tokens: this.maxTokens,
      ...(system
        ? { system: this.cache ? cacheSystem(system) : system }
        : {}),
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
      messages: this.cache ? cacheLastMessage(messages) : messages,
      ...(input.tools.length > 0 ? { tools: toAnthropicTools(input.tools) } : {}),
    };
  }

  /**
   * Reads Anthropic's server-sent events.
   *
   * The stream is a sequence of `content_block_start`, `content_block_delta`
   * and `content_block_stop` events. A tool call's arguments arrive as
   * `input_json_delta` fragments, which are joined until the block ends.
   */
  private async readStream(
    stream: AsyncIterable<Uint8Array>,
    onEvent: ProviderStreamSink,
  ): Promise<ProviderResponse> {
    const blocks = new Map<
      number,
      { type: string; id?: string; name?: string; text: string; json: string }
    >();
    const textParts: string[] = [];
    const toolCalls: ProviderToolCall[] = [];
    let stopReason: string | undefined;

    for await (const event of readSseEvents(stream)) {
      if (!event.data || event.data === '[DONE]') continue;

      let payload: AnthropicStreamEvent;
      try {
        payload = JSON.parse(event.data) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      switch (payload.type) {
        case 'content_block_start': {
          const block = payload.content_block ?? {};
          blocks.set(payload.index ?? 0, {
            type: block.type ?? 'text',
            id: block.id,
            name: block.name,
            text: '',
            json: '',
          });
          break;
        }

        case 'content_block_delta': {
          const index = payload.index ?? 0;
          const block = blocks.get(index) ?? {
            type: 'text',
            text: '',
            json: '',
          };
          const delta = payload.delta ?? {};

          if (delta.type === 'text_delta') {
            const text = delta.text ?? '';
            block.text += text;
            textParts.push(text);
            onEvent({ type: 'message_delta', text });
          } else if (delta.type === 'thinking_delta') {
            const text = delta.thinking ?? '';
            block.text += text;
            onEvent({ type: 'thinking_delta', text });
          } else if (delta.type === 'input_json_delta') {
            block.json += delta.partial_json ?? '';
          }

          blocks.set(index, block);
          break;
        }

        case 'content_block_stop': {
          const block = blocks.get(payload.index ?? 0);
          if (block && block.type === 'tool_use') {
            const call: ProviderToolCall = {
              id: block.id ?? `toolu_${payload.index ?? 0}`,
              name: block.name ?? 'tool',
              arguments: block.json.length > 0 ? block.json : '{}',
            };
            toolCalls.push(call);
            onEvent({ type: 'tool_call', call });
          }
          break;
        }

        case 'message_delta': {
          stopReason = payload.delta?.stop_reason ?? stopReason;
          break;
        }

        default:
          break;
      }
    }

    const content = textParts.length > 0 ? textParts.join('') : null;

    return {
      content,
      toolCalls,
      finishReason:
        toolCalls.length > 0 ? 'tool_calls' : mapStopReason(stopReason),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Prompt caching                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The system prompt, as a cached content block.
 *
 * Anthropic only accepts `cache_control` on a block, so a cached system
 * prompt is an array with one block in it.
 */
export function cacheSystem(system: string): unknown[] {
  return [
    {
      type: 'text',
      text: system,
      cache_control: { type: 'ephemeral' },
    },
  ];
}

/**
 * Puts the cache breakpoint on the last message.
 *
 * The breakpoint marks the end of the stable prefix: everything up to it
 * is cached, so the next turn only pays for what comes after.
 */
export function cacheLastMessage(messages: AnthropicMessage[]): AnthropicMessage[] {
  if (messages.length === 0) return messages;

  const out = messages.map((message) => ({
    ...message,
    content: message.content.map((block) => ({ ...block })),
  }));

  const last = out[out.length - 1]!;
  const lastBlock = last.content[last.content.length - 1];
  if (lastBlock) {
    last.content[last.content.length - 1] = {
      ...lastBlock,
      cache_control: { type: 'ephemeral' },
    };
  }

  return out;
}

/** The events Anthropic's stream sends. */
interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    text?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
}

/* -------------------------------------------------------------------------- */
/* Muca -> Anthropic                                                          */
/* -------------------------------------------------------------------------- */

/** The content blocks Anthropic understands. */
type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      cache_control?: CacheControl;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
      cache_control?: CacheControl;
    };

/** Anthropic's prompt-cache marker. */
export interface CacheControl {
  type: 'ephemeral';
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[];
}

/**
 * Splits the system messages out of the conversation.
 *
 * Anthropic takes the system prompt as a top-level string, not as a
 * message.
 */
export function splitSystem(messages: ProviderMessage[]): {
  system: string | null;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) systemParts.push(message.content);
      continue;
    }

    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.toolCallId ?? 'unknown',
            content: message.content ?? '',
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const content: AnthropicContentBlock[] = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: parseToolInput(call.arguments),
        });
      }
      out.push({ role: 'assistant', content });
      continue;
    }

    out.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: message.content ?? '' }],
    });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
    messages: out,
  };
}

/** Maps Muca's tool catalogue onto Anthropic's `tools`. */
export function toAnthropicTools(tools: ProviderTool[]): unknown[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/** Parses raw tool arguments into the object Anthropic expects. */
function parseToolInput(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/* -------------------------------------------------------------------------- */
/* Anthropic -> Muca                                                          */
/* -------------------------------------------------------------------------- */

/** The parts of an Anthropic response this adapter reads. */
export interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  stop_reason?: string;
}

/** Converts an Anthropic response into the neutral response shape. */
export function fromAnthropicResponse(payload: AnthropicResponse): ProviderResponse {
  const blocks = payload.content ?? [];

  const toolCalls: ProviderToolCall[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }
    if (block.type === 'tool_use' && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }

  const content = textParts.length > 0 ? textParts.join('') : null;

  return {
    content,
    toolCalls,
    finishReason:
      toolCalls.length > 0 ? 'tool_calls' : mapStopReason(payload.stop_reason),
    raw: payload,
  };
}

/** Strips anything that looks like a key out of an error body. */
function sanitise(body: string): string {
  return body
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza[redacted]')
    .slice(0, 300);
}

/** The default `fetch`, adapted to the narrow interface the adapter needs. */
const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
    body: response.body
      ? (response.body as unknown as AsyncIterable<Uint8Array>)
      : null,
  };
};
