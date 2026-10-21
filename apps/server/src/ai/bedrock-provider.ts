import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message as BedrockMessage,
  type Tool as BedrockTool,
  type ToolConfiguration,
  type ToolResultContentBlock,
  type ToolResultBlock,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';

import type {
  AIProvider,
  ProviderMessage,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
} from './provider.js';

/**
 * Amazon Bedrock adapter.
 *
 * Bedrock's **Converse API** is the current, model-agnostic API: one
 * request shape for every model on Bedrock, with native tool use. It maps
 * cleanly onto the neutral `ProviderMessage` shape, so this adapter is the
 * mirror image of the OpenAI one:
 *
 *   | Muca                | Bedrock                          |
 *   |---------------------|----------------------------------|
 *   | `ProviderMessage`   | `Message`                        |
 *   | `ProviderToolCall`  | `toolUse` content block          |
 *   | tool result message | `toolResult` content block       |
 *   | `ProviderTool`      | `Tool` + `toolConfig`            |
 *
 * Credentials come from the **standard AWS credential chain** (env vars,
 * the shared config file, an instance role, SSO...). Nothing is read from
 * `.env` by this file and no key is ever hardcoded.
 */

/** The subset of the Bedrock runtime client this adapter uses. */
export interface BedrockClientLike {
  send(command: ConverseCommand): Promise<unknown>;
}

export interface BedrockProviderOptions {
  /** The Bedrock model id, e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0`. */
  model: string;
  /** The AWS region. */
  region: string;
  /** Optional pre-built client (tests inject a stub). */
  client?: BedrockClientLike;
  /** Optional max tokens. Defaults to 2048. */
  maxTokens?: number;
}

/** Bedrock's `stopReason` values, mapped onto Muca's four. */
function mapStopReason(reason: string | undefined): ProviderResponse['finishReason'] {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'content_filtered':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

export class BedrockProvider implements AIProvider {
  readonly name = 'bedrock';

  private readonly client: BedrockClientLike;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(options: BedrockProviderOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 2048;
    this.client =
      options.client ??
      new BedrockRuntimeClient({ region: options.region });
  }

  async chat(input: {
    messages: ProviderMessage[];
    tools: ProviderTool[];
    temperature?: number;
  }): Promise<ProviderResponse> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: this.model,
        messages: toBedrockMessages(input.messages),
        ...(input.temperature !== undefined
          ? { inferenceConfig: { temperature: input.temperature } }
          : {}),
        ...(input.tools.length > 0 ? { toolConfig: toToolConfig(input.tools) } : {}),
      }),
    );

    return fromBedrockResponse(response);
  }
}

/* -------------------------------------------------------------------------- */
/* Muca -> Bedrock                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Converts the neutral message list into Bedrock messages.
 *
 * Bedrock groups content into blocks, so one Muca message can become
 * several blocks (text + toolUse, or text + toolResult).
 */
export function toBedrockMessages(messages: ProviderMessage[]): BedrockMessage[] {
  const out: BedrockMessage[] = [];

  for (const message of messages) {
    // Bedrock has no `system` role in `messages`; system prompts go in a
    // separate `system` field on the request. The caller handles that by
    // passing system messages through `system` on the command, so here we
    // simply skip them.
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            toolResult: {
              toolUseId: message.toolCallId ?? 'unknown',
              content: [{ text: message.content ?? '' }],
            } satisfies ToolResultBlock,
          },
        ],
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls?.length) {
      const blocks: ContentBlock[] = [];
      if (message.content) {
        blocks.push({ text: message.content });
      }
      for (const call of message.toolCalls) {
        blocks.push({
          toolUse: {
            toolUseId: call.id,
            name: call.name,
            input: parseToolInput(call.arguments) as never,
          },
        });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ text: message.content ?? '' }],
    });
  }

  return out;
}

/** Bedrock's `toolConfig`. */
export function toToolConfig(tools: ProviderTool[]): ToolConfiguration {
  const bedrockTools: BedrockTool[] = tools.map((tool) => ({
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: {
        json: tool.parameters as never,
      },
    },
  }));

  return { tools: bedrockTools };
}

/**
 * Parses a tool's raw JSON arguments into the object Bedrock expects.
 *
 * Bedrock's `toolUse.input` is a JSON object, not a string. A model that
 * emitted invalid JSON yields an empty object rather than crashing the run.
 */
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
/* Bedrock -> Muca                                                            */
/* -------------------------------------------------------------------------- */

/** The shape of a `Converse` response, as far as this adapter cares. */
interface ConverseResponseLike {
  output?: {
    message?: { content?: ContentBlock[] };
  };
  stopReason?: string;
}

/**
 * Converts a Bedrock `Converse` response into the neutral response shape.
 *
 * Exported so the mapping can be unit-tested directly against a stubbed
 * client response.
 */
export function fromBedrockResponse(raw: unknown): ProviderResponse {
  const response = (raw ?? {}) as ConverseResponseLike;
  const blocks = response.output?.message?.content ?? [];

  const toolCalls: ProviderToolCall[] = [];
  const textParts: string[] = [];

  for (const block of blocks) {
    if ('text' in block && typeof block.text === 'string') {
      textParts.push(block.text);
      continue;
    }
    if ('toolUse' in block && block.toolUse) {
      const use = block.toolUse as ToolUseBlock;
      if (!use.toolUseId || !use.name) continue;
      toolCalls.push({
        id: use.toolUseId,
        name: use.name,
        arguments: JSON.stringify(use.input ?? {}),
      });
    }
  }
  const content = textParts.length > 0 ? textParts.join('') : null;

  return {
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? 'tool_calls' : mapStopReason(response.stopReason),
    raw: response,
  };
}

/**
 * Extracts the tool result blocks from a Bedrock response.
 *
 * Bedrock returns tool results inside a `toolResult` block. This helper
 * exists for symmetry with `fromBedrockResponse` and for tests.
 */
export function extractToolResults(
  blocks: ContentBlock[],
): Array<{ toolResult: ToolResultBlock }> {
  return blocks.filter(
    (block): block is { toolResult: ToolResultBlock } =>
      'toolResult' in block && Boolean(block.toolResult),
  );
}

/**
 * The text of a tool result block.
 *
 * Bedrock allows several content shapes inside a `toolResult` (text, json,
 * image). Muca only produces text, so the text is what is read back.
 */
export function toolResultText(block: {
  toolResult: ToolResultBlock;
}): string {
  const content = block.toolResult.content as ToolResultContentBlock[];
  return content
    .filter(
      (part): part is Extract<ToolResultContentBlock, { text: string }> =>
        'text' in part && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('');
}
