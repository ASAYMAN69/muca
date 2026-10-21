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

  /** Which AI provider to use: `openai` (default) or `bedrock`. */
  AI_PROVIDER: z.enum(['openai', 'bedrock']).default('openai'),

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  /** The Bedrock model id. Never hardcoded in source. */
  BEDROCK_MODEL_ID: z.string().default(''),
  /** The AWS region for Bedrock. */
  AWS_REGION: z.string().default('us-east-1'),

  MCP_PROTOCOL_VERSION: z.string().default('2025-11-25'),
  MCP_PUBLIC_URL: z.string().default(''),

  /** Where the run history is written. Relative paths resolve from the repo root. */
  RUN_HISTORY_DIR: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  allowedOrigins: string[];
  ai: {
    /** Which provider is in use. */
    provider: 'openai' | 'bedrock';
    /** True when the provider is configured well enough to run the agent. */
    enabled: boolean;
    openai: {
      apiKey: string;
      baseUrl: string;
      model: string;
    };
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
  /** The directory the run history is written to. Empty means "the default". */
  runHistoryDir: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);

  const allowedOrigins = parsed.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const publicUrl =
    parsed.MCP_PUBLIC_URL.trim() ||
    `http://localhost:${parsed.PORT}/api/v1/mcp`;

  const provider = parsed.AI_PROVIDER;
  const openaiKey = parsed.OPENAI_API_KEY.trim();
  const bedrockModel = parsed.BEDROCK_MODEL_ID.trim();

  // The provider is only "enabled" when it is actually usable. Bedrock
  // needs a model id; the credentials come from the standard AWS chain
  // and are resolved lazily by the SDK.
  const enabled =
    provider === 'bedrock' ? bedrockModel.length > 0 : openaiKey.length > 0;

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    allowedOrigins,
    ai: {
      provider,
      enabled,
      openai: {
        apiKey: openaiKey,
        baseUrl: parsed.OPENAI_BASE_URL.replace(/\/+$/, ''),
        model: parsed.OPENAI_MODEL,
      },
      bedrock: {
        modelId: bedrockModel,
        region: parsed.AWS_REGION.trim() || 'us-east-1',
      },
    },
    mcp: {
      protocolVersion: parsed.MCP_PROTOCOL_VERSION,
      publicUrl,
    },
    runHistoryDir: parsed.RUN_HISTORY_DIR.trim(),
  };
}
