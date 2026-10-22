import { z } from 'zod';

import type { ProviderStreamEvent } from './stream.js';

export type { ProviderStreamEvent } from './stream.js';

/**
 * Provider-agnostic tool definition. This is the shape the agent loop works
 * with, independent of which AI SDK is behind it.
 */
export interface ProviderTool {
  name: string;
  description: string;
  /** JSON Schema object describing the accepted arguments. */
  parameters: Record<string, unknown>;
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Set on assistant messages that request tool calls. */
  toolCalls?: ProviderToolCall[];
  /** Set on tool-result messages. */
  toolCallId?: string;
  /** Set on tool-result messages so the provider can match the tool name. */
  name?: string;
}

export interface ProviderToolCall {
  id: string;
  name: string;
  /** Raw JSON string of the arguments as produced by the model. */
  arguments: string;
}

export interface ProviderResponse {
  content: string | null;
  toolCalls: ProviderToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';
  raw?: unknown;
}

/**
 * The only surface the agent loop depends on. Swap OpenAI for another
 * provider by implementing this interface — nothing else in the codebase
 * needs to change.
 */
export interface AIProvider {
  readonly name: string;
  chat(input: {
    messages: ProviderMessage[];
    tools: ProviderTool[];
    temperature?: number;
  }): Promise<ProviderResponse>;

  /**
   * Streams the reply, if this provider can.
   *
   * It is **optional**: a provider that cannot stream still works, and
   * the agent falls back to one ordinary call and reports the text as a
   * single delta. The MCP path uses `chat` and is unaffected.
   */
  chatStream?(
    input: {
      messages: ProviderMessage[];
      tools: ProviderTool[];
      temperature?: number;
    },
    onEvent: (event: ProviderStreamEvent) => void,
  ): Promise<ProviderResponse>;
}

/** Zod schema for a tool argument envelope used by the OpenAI adapter. */
export const toolCallArgumentsSchema = z.record(z.string(), z.unknown());
