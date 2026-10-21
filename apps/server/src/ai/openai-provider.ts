import OpenAI from 'openai';

import type {
  AIProvider,
  ProviderMessage,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
} from './provider.js';

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
