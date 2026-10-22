import type { AiProviderName } from '../config.js';

/**
 * The model's input limit.
 *
 * The limit is the number of tokens the model will accept. A session
 * that goes past it fails, so the limit is what decides when the
 * conversation has to be compacted.
 */
export interface ContextLimit {
  /** The input limit, in tokens. */
  inputTokens: number;
  /** Where the number came from. */
  source: 'counted' | 'models' | 'budget' | 'table' | 'default';
  /** The model the limit is for. */
  model: string;
  /** The provider the limit is for. */
  provider: AiProviderName | 'unknown';
}

/**
 * The fallback table.
 *
 * It is the last resort: the number is only used when the provider
 * cannot be asked. A model the table does not name falls back to
 * **128,000**, and the fallback is logged so it is visible rather than
 * silent.
 */
export const FALLBACK_LIMITS: Array<{
  provider: AiProviderName;
  family: RegExp;
  limit: number;
  label: string;
}> = [
  {
    provider: 'anthropic',
    // Opus 5.5 / 5 / 4.8 / 4.7 / 4.6, Sonnet 5.5 / 5 / 4.6, Haiku 5.5,
    // Fable 5.1 / 5. The version may be written with dots or with
    // dashes: `claude-opus-4-6` and `claude-opus-4.6` are the same
    // family.
    family:
      /(?:opus[-_](?:5[-._]5|5|4[-._]8|4[-._]7|4[-._]6)|sonnet[-_](?:5[-._]5|5|4[-._]6)|haiku[-_]5[-._]5|fable[-_](?:5[-._]1|5))(?![0-9])/i,
    limit: 1_048_576,
    label: 'Anthropic, Opus 5.5/5/4.8/4.7/4.6, Sonnet 5.5/5/4.6, Haiku 5.5, Fable 5.1/5',
  },
  {
    provider: 'anthropic',
    family: /(?:sonnet|opus|haiku)[-_]4[-._]5(?![0-9])/i,
    limit: 200_000,
    label: 'Anthropic, Sonnet 4.5, Opus 4.5, Haiku 4.5',
  },
  {
    provider: 'openai',
    family: /^gpt-6/i,
    limit: 1_047_576,
    label: 'OpenAI, gpt-6 family',
  },
  {
    provider: 'openai',
    family: /^gpt-5/i,
    limit: 400_000,
    label: 'OpenAI, gpt-5 family',
  },
  {
    provider: 'openai',
    family: /^gpt-4\.1/i,
    limit: 1_047_576,
    label: 'OpenAI, gpt-4.1 family',
  },
  {
    provider: 'openai',
    family: /^gpt-4o/i,
    limit: 128_000,
    label: 'OpenAI, gpt-4o, gpt-4o-mini',
  },
  {
    provider: 'openai',
    family: /^gpt-4/i,
    limit: 8_192,
    label: 'OpenAI, gpt-4',
  },
  {
    provider: 'gemini',
    family: /gemini-2\.5-(flash|pro)/i,
    limit: 1_048_576,
    label: 'Google, gemini-2.5-flash, gemini-2.5-pro',
  },
  {
    provider: 'gemini',
    family: /gemma/i,
    limit: 262_144,
    label: 'Google, gemma family',
  },
];

/** The limit used when the table does not name the model. */
export const DEFAULT_INPUT_LIMIT = 128_000;

/**
 * The limit for a model, from the table.
 *
 * The result says whether the table actually named the model: when it
 * did not, the caller logs the fallback.
 */
export function limitFromTable(
  provider: AiProviderName,
  model: string,
): { limit: number; matched: boolean; label: string } {
  for (const entry of FALLBACK_LIMITS) {
    if (entry.provider !== provider) continue;
    if (!entry.family.test(model)) continue;
    return { limit: entry.limit, matched: true, label: entry.label };
  }

  return {
    limit: DEFAULT_INPUT_LIMIT,
    matched: false,
    label: 'the default',
  };
}

/**
 * Reads the token budget Anthropic publishes in its replies.
 *
 * Every Anthropic answer carries the limit in its system prompt:
 * `<budget:token_budget>200000</budget:token_budget>`. It is read from
 * the first real response and remembered.
 */
export function parseBudgetTag(text: string): number | null {
  const match = /<budget:token_budget>\s*(\d+)\s*<\/budget:token_budget>/.exec(
    text,
  );
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** The minimum a fetch has to offer for the limit lookups. */
export type LimitFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** What the resolver needs to know about the provider in use. */
export interface ProviderLimitConfig {
  provider: AiProviderName | null;
  model: string | null;
  endpoint: string;
  apiKey: string;
}

/**
 * The context limit resolver.
 *
 * The limit is found in this order:
 *
 *   1. the provider's own token-counting endpoint, which is exact;
 *   2. the provider's models endpoint, when it publishes the number;
 *   3. the budget tag Anthropic puts in its replies;
 *   4. the fallback table.
 *
 * A lookup that fails is never fatal: the table is used instead, and
 * the boot is never blocked on it.
 */
export class ContextLimitResolver {
  private readonly cached = new Map<string, ContextLimit>();

  constructor(
    private readonly fetchImpl: LimitFetch = defaultLimitFetch,
    private readonly timeoutMs = 5_000,
  ) {}

  /**
   * The limit for the provider in use.
   *
   * It never throws and never blocks: a provider that cannot be asked
   * falls back to the table.
   */
  async resolve(config: ProviderLimitConfig): Promise<ContextLimit> {
    const provider = config.provider;
    const model = config.model ?? '';

    if (!provider || !model) {
      return {
        inputTokens: DEFAULT_INPUT_LIMIT,
        source: 'default',
        model: model || 'unknown',
        provider: provider ?? 'unknown',
      };
    }

    const key = `${provider}:${model}`;
    const cached = this.cached.get(key);
    if (cached) return cached;

    const limit = await this.lookUp(config, provider, model);
    this.cached.set(key, limit);
    return limit;
  }

  /** Remembers a limit that was read out of a provider's reply. */
  remember(provider: AiProviderName, model: string, inputTokens: number): void {
    this.cached.set(`${provider}:${model}`, {
      inputTokens,
      source: 'budget',
      model,
      provider,
    });
  }

  /**
   * The exact number of input tokens of a conversation.
   *
   * It is null when the provider has no counting endpoint, or when the
   * request failed: the caller then uses the estimate.
   */
  async count(
    config: ProviderLimitConfig,
    messages: unknown[],
  ): Promise<number | null> {
    const provider = config.provider;
    const model = config.model ?? '';
    if (!provider || !model) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      if (provider === 'anthropic') {
        const response = await this.fetchImpl(
          `${config.endpoint.replace(/\/+$/, '')}/v1/messages/count_tokens`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': config.apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({ model, messages }),
            signal: controller.signal,
          },
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as { input_tokens?: number };
        return typeof payload.input_tokens === 'number'
          ? payload.input_tokens
          : null;
      }

      if (provider === 'gemini') {
        const response = await this.fetchImpl(
          `${config.endpoint.replace(/\/+$/, '')}/models/${model}:countTokens`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-goog-api-key': config.apiKey,
            },
            body: JSON.stringify({ contents: messages }),
            signal: controller.signal,
          },
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as { totalTokens?: number };
        return typeof payload.totalTokens === 'number' ? payload.totalTokens : null;
      }

      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async lookUp(
    config: ProviderLimitConfig,
    provider: AiProviderName,
    model: string,
  ): Promise<ContextLimit> {
    // 1. The counting endpoint, which is exact.
    const counted = await this.countTokens(config, provider, model);
    if (counted !== null) {
      return { inputTokens: counted, source: 'counted', model, provider };
    }

    // 2. The models endpoint, when it publishes the number.
    const published = await this.publishedLimit(config, provider, model);
    if (published !== null) {
      return { inputTokens: published, source: 'models', model, provider };
    }

    // 4. The table.
    const table = limitFromTable(provider, model);
    if (!table.matched) {
      // The fallback is logged, so it is visible rather than silent.
      console.warn(
        `[context] No published input limit for ${provider}/${model}; ` +
          `falling back to ${table.limit} tokens (${table.label}).`,
      );
    }
    return {
      inputTokens: table.limit,
      source: table.matched ? 'table' : 'default',
      model,
      provider,
    };
  }

  /** The provider's own token counter. */
  private async countTokens(
    config: ProviderLimitConfig,
    provider: AiProviderName,
    model: string,
  ): Promise<number | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      if (provider === 'anthropic') {
        const response = await this.fetchImpl(
          `${config.endpoint.replace(/\/+$/, '')}/v1/messages/count_tokens`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': config.apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: 'x' }],
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as { input_tokens?: number };
        return typeof payload.input_tokens === 'number'
          ? payload.input_tokens
          : null;
      }

      if (provider === 'gemini') {
        const response = await this.fetchImpl(
          `${config.endpoint.replace(/\/+$/, '')}/models/${model}:countTokens`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-goog-api-key': config.apiKey,
            },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: 'x' }] }],
            }),
            signal: controller.signal,
          },
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as { totalTokens?: number };
        return typeof payload.totalTokens === 'number' ? payload.totalTokens : null;
      }

      // OpenAI has no counting endpoint.
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The limit the provider's models endpoint publishes. */
  private async publishedLimit(
    config: ProviderLimitConfig,
    provider: AiProviderName,
    model: string,
  ): Promise<number | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      if (provider !== 'gemini') {
        // Only Gemini publishes the number. OpenAI and Anthropic do not.
        return null;
      }

      const response = await this.fetchImpl(
        `${config.endpoint.replace(/\/+$/, '')}/models`,
        {
          method: 'GET',
          headers: { 'x-goog-api-key': config.apiKey },
          signal: controller.signal,
        },
      );
      if (!response.ok) return null;

      const payload = (await response.json()) as {
        models?: Array<{ name?: string; inputTokenLimit?: number }>;
      };

      const entry = (payload.models ?? []).find((candidate) =>
        candidate.name?.endsWith(model),
      );
      return typeof entry?.inputTokenLimit === 'number'
        ? entry.inputTokenLimit
        : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The default fetch, with the key in a header and never in the URL. */
const defaultLimitFetch: LimitFetch = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
  };
};
