import { z } from 'zod';

/**
 * Environment schema. Everything the server needs is read from the process
 * environment exactly once, at startup, so a misconfigured deployment fails
 * loudly instead of failing on the first tool call.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8099),

  ALLOWED_ORIGINS: z.string().default(''),

  /**
   * Which AI provider to use.
   *
   * `auto` probes every configured endpoint in parallel at startup and
   * uses the highest-priority one that actually answers. An explicit
   * name uses that provider only — it never silently falls back.
   */
  AI_PROVIDER: z
    .enum(['auto', 'anthropic', 'openai', 'gemini', 'bedrock'])
    .default('auto'),

  /** How long a single probe may take before it counts as failed. */
  // The probe sends one real request, so the budget must tolerate a cold
  // start and a throttled provider: measured against Google Gemini, a
  // healthy call takes ~1s but a rate-limited one can take 20s and still
  // succeed. A short budget would report a working key as unusable and
  // silently disable the agent, which is worse than a slow boot.
  AI_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // --- Anthropic ----------------------------------------------------------
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_ENDPOINT: z.string().default('https://api.anthropic.com'),
  /**
   * The Anthropic model id.
   *
   * There is no safe default: the operator must name one. An empty value
   * means "Anthropic is not configured".
   */
  ANTHROPIC_MODEL: z.string().default(''),

  // --- OpenAI (and OpenAI-compatible) -------------------------------------
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_ENDPOINT: z.string().default(''),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  /**
   * The old name for `OPENAI_ENDPOINT`.
   *
   * Kept as a deprecated alias so an existing `.env` keeps working. The
   * new name wins when both are set.
   */
  OPENAI_BASE_URL: z.string().default(''),

  // --- Google Gemini ------------------------------------------------------
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_ENDPOINT: z
    .string()
    .default('https://generativelanguage.googleapis.com/v1beta'),
  // The default must be a model that actually exists, and the free tier
  // is per model: `gemini-2.0-flash` has been retired by Google, and
  // `gemini-2.5-flash` is capped at 20 requests a day on the free tier,
  // which is exhausted by a single demo session. The lite model has its
  // own, much larger allowance.
  GEMINI_MODEL: z.string().default('gemini-2.5-flash-lite'),

  // --- Bedrock ------------------------------------------------------------
  /** The Bedrock model id. Never hardcoded in source. */
  BEDROCK_MODEL_ID: z.string().default(''),
  /** The AWS region for Bedrock. */
  AWS_REGION: z.string().default('us-east-1'),

  MCP_PROTOCOL_VERSION: z.string().default('2025-11-25'),
  MCP_PUBLIC_URL: z.string().default(''),

  /**
   * The SQLite database.
   *
   * One global database, by default `~/.adh/database/muca.db`. The path
   * is configurable so the tests can point at a temporary file — they
   * must never touch the user's real database.
   */
  MUCA_DATABASE_PATH: z.string().default(''),

  /**
   * The fraction of the model's input limit at which a conversation is
   * compacted. 0.8 means "compact when four fifths of the window is
   * full".
   */
  CONTEXT_COMPACTION_THRESHOLD: z.coerce.number().min(0.1).max(0.99).default(0.8),

  /** How many turns are kept verbatim when a conversation is compacted. */
  CONTEXT_KEEP_TURNS: z.coerce.number().int().min(1).max(20).default(3),
});

export type Env = z.infer<typeof envSchema>;

/** The AI providers the gateway can route to. */
export type AiProviderName = 'anthropic' | 'openai' | 'gemini' | 'bedrock';

/** How the provider was chosen. */
export type AiProviderMode = 'auto' | 'explicit';

/** The per-provider configuration, as read from the environment. */
export interface ProviderConfig {
  apiKey: string;
  endpoint: string;
  model: string;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  allowedOrigins: string[];
  ai: {
    /**
     * The requested provider. `auto` means "pick the best available".
     */
    requested: AiProviderName | 'auto';
    /** The mode the gateway runs in. */
    mode: AiProviderMode;
    /** How long a single probe may take. */
    probeTimeoutMs: number;
    /**
     * The provider actually in use, or null when none is usable.
     *
     * Set by the gateway at startup; `null` means the server runs without
     * a model (MCP, the tools and the demo mode all still work).
     */
    selected: AiProviderName | null;
    /** The model of the selected provider. */
    model: string | null;
    /** True when a usable provider was found. */
    enabled: boolean;
    anthropic: ProviderConfig;
    openai: ProviderConfig;
    gemini: ProviderConfig;
    bedrock: {
      /** The model id. Empty when it is not configured. */
      modelId: string;
      region: string;
    };
  };
  mcp: {
    protocolVersion: string;
    publicUrl: string;
  };
  /** The SQLite database. Empty means "the default". */
  databasePath: string;
  /** The fraction of the input limit at which a conversation is compacted. */
  compactionThreshold: number;
  /** How many turns are kept verbatim when a conversation is compacted. */
  compactionKeepTurns: number;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);

  const allowedOrigins = parsed.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const publicUrl =
    parsed.MCP_PUBLIC_URL.trim() ||
    `http://localhost:${parsed.PORT}/api/v1/mcp`;

  const requested = parsed.AI_PROVIDER;
  const mode: AiProviderMode = requested === 'auto' ? 'auto' : 'explicit';

  // The deprecated `OPENAI_BASE_URL` still works; the new name wins when
  // both are set. The fallback is the real OpenAI endpoint.
  const openaiEndpoint = trimTrailingSlashes(
    parsed.OPENAI_ENDPOINT.trim() ||
      parsed.OPENAI_BASE_URL.trim() ||
      'https://api.openai.com/v1',
  );

  const anthropic: ProviderConfig = {
    apiKey: parsed.ANTHROPIC_API_KEY.trim(),
    endpoint: trimTrailingSlashes(parsed.ANTHROPIC_ENDPOINT.trim()),
    model: parsed.ANTHROPIC_MODEL.trim(),
  };

  const openai: ProviderConfig = {
    apiKey: parsed.OPENAI_API_KEY.trim(),
    endpoint: openaiEndpoint,
    model: parsed.OPENAI_MODEL.trim(),
  };

  const gemini: ProviderConfig = {
    apiKey: parsed.GEMINI_API_KEY.trim(),
    endpoint: trimTrailingSlashes(parsed.GEMINI_ENDPOINT.trim()),
    model: parsed.GEMINI_MODEL.trim(),
  };

  const bedrockModel = parsed.BEDROCK_MODEL_ID.trim();

  // The selected provider is decided by the gateway at startup. Until it
  // runs, the configuration only says what was *requested*.
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    allowedOrigins,
    ai: {
      requested,
      mode,
      probeTimeoutMs: parsed.AI_PROBE_TIMEOUT_MS,
      selected: null,
      model: null,
      enabled: false,
      anthropic,
      openai,
      gemini,
      bedrock: {
        modelId: bedrockModel,
        region: parsed.AWS_REGION.trim() || 'us-east-1',
      },
    },
    mcp: {
      protocolVersion: parsed.MCP_PROTOCOL_VERSION,
      publicUrl,
    },
    databasePath: parsed.MUCA_DATABASE_PATH.trim(),
    compactionThreshold: parsed.CONTEXT_COMPACTION_THRESHOLD,
    compactionKeepTurns: parsed.CONTEXT_KEEP_TURNS,
  };
}
