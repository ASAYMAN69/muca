import type { AiProviderName, AppConfig } from '../config.js';
import { AnthropicProvider } from './anthropic-provider.js';
import { BedrockProvider } from './bedrock-provider.js';
import { GeminiProvider } from './gemini-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import type { AIProvider } from './provider.js';

/**
 * Builds the `AIProvider` for a gateway decision.
 *
 * The gateway decides *which* provider; this decides *how* to talk to it.
 * Each adapter implements the same neutral interface, so the agent loop
 * does not know or care which one is in use.
 */
export function createProvider(
  config: AppConfig,
  selected: AiProviderName | null,
): AIProvider | null {
  if (!selected) return null;

  switch (selected) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: config.ai.anthropic.apiKey,
        endpoint: config.ai.anthropic.endpoint,
        model: config.ai.anthropic.model,
      });
    case 'openai':
      return new OpenAIProvider({
        apiKey: config.ai.openai.apiKey,
        baseUrl: config.ai.openai.endpoint,
        model: config.ai.openai.model,
      });
    case 'gemini':
      return new GeminiProvider({
        apiKey: config.ai.gemini.apiKey,
        endpoint: config.ai.gemini.endpoint,
        model: config.ai.gemini.model,
      });
    case 'bedrock':
      return new BedrockProvider({
        model: config.ai.bedrock.modelId,
        region: config.ai.bedrock.region,
      });
  }
}
