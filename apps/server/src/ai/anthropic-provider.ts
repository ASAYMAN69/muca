import type {
  AIProvider,
  ProviderMessage,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
} from './provider.js';

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

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 2048;
    this.apiVersion = options.apiVersion ?? '2023-06-01';
    this.fetchImpl = options.fetchImpl ?? (defaultFetch as FetchLike);
  }

  async chat(input: {
    messages: ProviderMessage[];
    tools: ProviderTool[];
    temperature?: number;
  }): Promise<ProviderResponse> {
    const { system, messages } = splitSystem(input.messages);

    const response = await this.fetchImpl(`${this.endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        ...(system ? { system } : {}),
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
        messages,
        ...(input.tools.length > 0 ? { tools: toAnthropicTools(input.tools) } : {}),
      }),
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
}

/* -------------------------------------------------------------------------- */
/* Muca -> Anthropic                                                          */
/* -------------------------------------------------------------------------- */

/** The content blocks Anthropic understands. */
type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

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
  };
};
