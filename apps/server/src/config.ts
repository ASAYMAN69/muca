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

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  MCP_PROTOCOL_VERSION: z.string().default('2025-11-25'),
  MCP_PUBLIC_URL: z.string().default(''),
});

export type Env = z.infer<typeof envSchema>;

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  allowedOrigins: string[];
  ai: {
    apiKey: string;
    baseUrl: string;
    model: string;
    /** True when a key is present and the agent loop can actually run. */
    enabled: boolean;
  };
  mcp: {
    protocolVersion: string;
    publicUrl: string;
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(source);

  const allowedOrigins = parsed.ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const publicUrl =
    parsed.MCP_PUBLIC_URL.trim() ||
    `http://localhost:${parsed.PORT}/api/v1/mcp`;

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    allowedOrigins,
    ai: {
      apiKey: parsed.OPENAI_API_KEY.trim(),
      baseUrl: parsed.OPENAI_BASE_URL.replace(/\/+$/, ''),
      model: parsed.OPENAI_MODEL,
      enabled: parsed.OPENAI_API_KEY.trim().length > 0,
    },
    mcp: {
      protocolVersion: parsed.MCP_PROTOCOL_VERSION,
      publicUrl,
    },
  };
}
