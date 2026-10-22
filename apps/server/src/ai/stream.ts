import type {
  ProviderMessage,
  ProviderResponse,
  ProviderTool,
  ProviderToolCall,
} from './provider.js';

/**
 * Provider streaming.
 *
 * The user wants to watch the model think, so the agent needs the tokens
 * as they arrive rather than the whole reply at the end. This module
 * defines the neutral shape every provider adapter streams into, so the
 * agent loop does not know which provider it is talking to.
 */

/** One thing that happened while the model was answering. */
export type ProviderStreamEvent =
  /** The model is reasoning. Not every model reasons. */
  | { type: 'thinking_delta'; text: string }
  /** A piece of the answer. */
  | { type: 'message_delta'; text: string }
  /** The model asked for a tool. The arguments are complete. */
  | { type: 'tool_call'; call: ProviderToolCall };

/** Where the deltas go. */
export type ProviderStreamSink = (event: ProviderStreamEvent) => void;

/**
 * A provider that can stream.
 *
 * It is a **sibling** of `AIProvider`, not a replacement: the MCP path
 * and the plain REST path use `chat` and must not change.
 */
export interface StreamingProvider {
  chatStream(
    input: {
      messages: ProviderMessage[];
      tools: ProviderTool[];
      temperature?: number;
    },
    onEvent: ProviderStreamSink,
  ): Promise<ProviderResponse>;
}

/** True when the provider can stream. */
export function isStreaming(
  provider: unknown,
): provider is StreamingProvider & { chat: unknown } {
  return (
    typeof provider === 'object' &&
    provider !== null &&
    typeof (provider as StreamingProvider).chatStream === 'function'
  );
}
