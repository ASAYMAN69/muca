import OpenAI from 'openai';

import type {
  AIProvider,
  ProviderMessage,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
} from './provider.js';
import type { ProviderStreamSink } from './stream.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

/**
 * OpenAI (and OpenAI-compatible) chat-completions adapter.
 *
 * Kept deliberately thin: it converts between the provider-neutral
 * `ProviderMessage` shape and the OpenAI wire format, and nothing else.
 */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';

  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
    this.model = options.model;
  }

  async chat(input: {
    messages: ProviderMessage[];
    tools: ProviderTool[];
    temperature?: number;
  }): Promise<ProviderResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: input.messages.map(toOpenAIMessage),
      // An empty `tools` array is rejected by the API, so the key is
      // omitted when there is nothing to offer.
      ...(input.tools.length > 0
        ? {
            tools: input.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      ...(input.temperature !== undefined
        ? { temperature: input.temperature }
        : {}),
    });

    const choice = completion.choices[0];
    if (!choice) {
      return { content: null, toolCalls: [], finishReason: 'unknown' };
    }

    const toolCalls: ProviderToolCall[] = (
      choice.message.tool_calls ?? []
    )
      // The SDK type is a union of function/custom tool calls. Muca only
      // registers function tools, so narrow to the function variant.
      .filter(
        (call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
          'function' in call,
      )
      .map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments ?? '{}',
      }));

    return {
      content: choice.message.content ?? null,
      toolCalls,
      finishReason: mapFinishReason(choice.finish_reason),
      raw: completion,
    };
  }

  /**
   * Streams the reply.
   *
   * The chat-completions API streams server-sent events when `stream` is
   * set. The deltas are handed to `onEvent` as they arrive; the returned
   * response has the same shape the non-streaming call returns.
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
    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create({
        model: this.model,
        messages: input.messages.map(toOpenAIMessage),
        ...(input.tools.length > 0
          ? {
              tools: input.tools.map((tool) => ({
                type: 'function' as const,
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
        ...(input.temperature !== undefined
          ? { temperature: input.temperature }
          : {}),
        stream: true,
      });
    } catch {
      // The provider refused to stream. One ordinary call still works.
      const result = await this.chat(input);
      if (result.content) onEvent({ type: 'message_delta', text: result.content });
      return result;
    }

    // The tool calls arrive in fragments, keyed by their index in the
    // choice's `tool_calls` array.
    const fragments = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    const textParts: string[] = [];
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta as
        | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
            reasoning_content?: string | null;
          })
        | undefined;

      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        onEvent({ type: 'thinking_delta', text: reasoning });
      }

      if (typeof delta?.content === 'string' && delta.content.length > 0) {
        textParts.push(delta.content);
        onEvent({ type: 'message_delta', text: delta.content });
      }

      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const entry = fragments.get(index) ?? {
          id: `call_${index}`,
          name: '',
          args: '',
        };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.name = call.function.name;
        if (call.function?.arguments) entry.args += call.function.arguments;
        fragments.set(index, entry);
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const toolCalls: ProviderToolCall[] = [...fragments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => ({
        id: entry.id,
        name: entry.name,
        arguments: entry.args.length > 0 ? entry.args : '{}',
      }));

    for (const call of toolCalls) {
      onEvent({ type: 'tool_call', call });
    }

    const content = textParts.length > 0 ? textParts.join('') : null;

    return {
      content,
      toolCalls,
      finishReason: mapFinishReason(finishReason),
    };
  }
}

function toOpenAIMessage(message: ProviderMessage): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.toolCallId ?? 'unknown',
      content: message.content ?? '',
    };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }

  return {
    role: message.role,
    content: message.content ?? '',
  };
}

function mapFinishReason(
  reason: string | null | undefined,
): ProviderResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}
