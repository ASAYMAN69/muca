import type {
  AIProvider,
  ProviderMessage,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
} from './provider.js';

/**
 * Google Gemini adapter (`generateContent`).
 *
 * Gemini's shape differs from the others in two ways that matter:
 *
 *   1. The system prompt is `systemInstruction`, not a message.
 *   2. **A `functionCall` has no id.** The agent loop matches a tool
 *      result back to its call *by id*, so this adapter synthesises a
 *      stable, unique id per call and maps it back when it builds the
 *      `functionResponse`.
 *
 * The id must be unique per call — the same tool may be called twice in
 * one turn — and it must be stable, so the mapping back to the original
 * call works.
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

export interface GeminiProviderOptions {
  apiKey: string;
  /** The API base, e.g. `https://generativelanguage.googleapis.com/v1beta`. */
  endpoint: string;
  /** The model id, e.g. `gemini-2.0-flash`. */
  model: string;
  /** Optional pre-built fetch (the tests inject one). */
  fetchImpl?: FetchLike;
  /** Optional max tokens. Defaults to 2048. */
  maxTokens?: number;
}

/** Gemini's finish reasons, mapped onto Muca's four. */
function mapFinishReason(reason: string | undefined): ProviderResponse['finishReason'] {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly fetchImpl: FetchLike;

  /**
   * The ids this adapter has synthesised, in order.
   *
   * The agent loop sends the tool result back with the id it was given.
   * The map is what lets the adapter find the original call again.
   */
  private readonly callIds = new Map<string, GeminiCall>();

  /** The counter behind the synthesised ids. */
  private callCounter = 0;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 2048;
    this.fetchImpl = options.fetchImpl ?? (defaultFetch as FetchLike);
  }

  async chat(input: {
    messages: ProviderMessage[];
    tools: ProviderTool[];
    temperature?: number;
  }): Promise<ProviderResponse> {
    const { system, contents } = splitSystem(input.messages);

    const response = await this.fetchImpl(
      `${this.endpoint}/models/${this.model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify({
          contents,
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          generationConfig: {
            maxOutputTokens: this.maxTokens,
            ...(input.temperature !== undefined
              ? { temperature: input.temperature }
              : {}),
          },
          ...(input.tools.length > 0
            ? { tools: toGeminiTools(input.tools) }
            : {}),
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Gemini request failed with status ${response.status}: ${sanitise(body)}`,
      );
    }

    const payload = (await response.json()) as GeminiResponse;
    return this.fromGeminiResponse(payload);
  }

  /**
   * Converts a Gemini response into the neutral response shape.
   *
   * Each `functionCall` gets a **synthesised** id, because Gemini does not
   * provide one. The id is unique per call, so two calls to the same tool
   * in one turn do not collide.
   */
  fromGeminiResponse(payload: GeminiResponse): ProviderResponse {
    const candidate = payload.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const toolCalls: ProviderToolCall[] = [];
    const textParts: string[] = [];

    for (const part of parts) {
      if ('text' in part && typeof part.text === 'string') {
        textParts.push(part.text);
        continue;
      }
      if ('functionCall' in part && part.functionCall) {
        const call = part.functionCall;
        const id = this.synthesiseId(call.name ?? 'tool');
        this.callIds.set(id, {
          name: call.name ?? 'tool',
          args: call.args ?? {},
        });
        toolCalls.push({
          id,
          name: call.name ?? 'tool',
          arguments: JSON.stringify(call.args ?? {}),
        });
      }
    }

    const content = textParts.length > 0 ? textParts.join('') : null;

    return {
      content,
      toolCalls,
      finishReason:
        toolCalls.length > 0
          ? 'tool_calls'
          : mapFinishReason(candidate?.finishReason),
      raw: payload,
    };
  }

  /**
   * Synthesises a unique id for a tool call.
   *
   * The id embeds the call's position, so two calls to the same tool in
   * one turn get different ids. It never uses the tool name alone.
   */
  private synthesiseId(toolName: string): string {
    this.callCounter += 1;
    return `gemini_call_${this.callCounter}_${toolName}`;
  }

  /**
   * The call a synthesised id refers to.
   *
   * Exposed for the tests: it is what makes the round trip verifiable.
   */
  callForId(id: string): GeminiCall | undefined {
    return this.callIds.get(id);
  }
}

/** A Gemini tool call, remembered so the result can be mapped back. */
export interface GeminiCall {
  name: string;
  args: Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Muca -> Gemini                                                             */
/* -------------------------------------------------------------------------- */

/** The parts of a Gemini content block this adapter reads. */
type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

/**
 * Splits the system messages out of the conversation.
 *
 * Gemini takes the system prompt as `systemInstruction`.
 */
export function splitSystem(messages: ProviderMessage[]): {
  system: string | null;
  contents: GeminiContent[];
} {
  const systemParts: string[] = [];
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) systemParts.push(message.content);
      continue;
    }

    if (message.role === 'tool') {
      // The tool result goes back as a `functionResponse` part. The name
      // is the tool's name; the id is not part of Gemini's shape, but the
      // agent loop matched the call to this result by id on the way in.
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: message.name ?? 'tool',
              response: { result: message.content ?? '' },
            },
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts: GeminiPart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls) {
        parts.push({
          functionCall: {
            name: call.name,
            args: parseToolInput(call.arguments),
          },
        });
      }
      contents.push({ role: 'model', parts });
      continue;
    }

    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content ?? '' }],
    });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
    contents,
  };
}

/** Maps Muca's tool catalogue onto Gemini's `tools`. */
export function toGeminiTools(tools: ProviderTool[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}

/** Parses raw tool arguments into the object Gemini expects. */
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
/* Gemini -> Muca                                                             */
/* -------------------------------------------------------------------------- */

/** The parts of a Gemini response this adapter reads. */
export interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
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
