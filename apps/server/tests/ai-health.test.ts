import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import { createApiRouter } from '../src/http/api.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import type { AIProvider, ProviderResponse } from '../src/ai/provider.js';
import type { ProbeResult } from '../src/ai/probe.js';

/**
 * The gateway's REST surface.
 *
 * `/health` keeps `enabled` and `provider` exactly as the web client
 * expects them, and adds the gateway's detail. `POST /ai/probe` re-runs
 * the probes without changing the provider in use.
 */

class StubProvider implements AIProvider {
  readonly name = 'anthropic';
  async chat(): Promise<ProviderResponse> {
    return { content: 'hi', toolCalls: [], finishReason: 'stop' };
  }
}

const PROBES: ProbeResult[] = [
  { provider: 'anthropic', status: 'ok', ok: true, latencyMs: 412 },
  { provider: 'openai', status: 'ok', ok: true, latencyMs: 890 },
  { provider: 'gemini', status: 'not_configured', ok: false, latencyMs: 0 },
];

interface HealthBody {
  status: string;
  ai: {
    enabled: boolean;
    provider: string | null;
    model?: string | null;
    mode?: string;
    selectedAt?: string;
    probes?: ProbeResult[];
  };
  tools: Array<{ name: string; taskBacked?: boolean }>;
}

describe('the AI gateway REST surface', () => {
  let httpServer: Server;
  let baseUrl: string;
  let probeCalls = 0;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createApiRouter({
        registry: new ToolRegistry().registerAll(createTools()),
        provider: new StubProvider(),
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
        ai: {
          enabled: true,
          provider: 'anthropic',
          model: 'claude-test',
          mode: 'auto',
          selectedAt: '2026-10-21T10:00:00.000Z',
          probes: PROBES,
        },
        probe: async () => {
          probeCalls += 1;
          return {
            probes: PROBES,
            applied: false,
            decision: {
              selected: 'anthropic',
              model: 'claude-test',
              enabled: true,
              probes: PROBES,
            },
          };
        },
      }),
    );

    httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('GET /health keeps enabled and provider for the web client', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as HealthBody;
    expect(body.ai.enabled).toBe(true);
    expect(body.ai.provider).toBe('anthropic');
  });

  it('GET /health adds mode, model, selectedAt and probes', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as HealthBody;

    expect(body.ai.mode).toBe('auto');
    expect(body.ai.model).toBe('claude-test');
    expect(body.ai.selectedAt).toBe('2026-10-21T10:00:00.000Z');
    expect(body.ai.probes).toHaveLength(3);
    expect(body.ai.probes?.[0]).toEqual({
      provider: 'anthropic',
      status: 'ok',
      ok: true,
      latencyMs: 412,
    });
  });

  it('GET /health reports the same tools as the MCP layer', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as HealthBody;

    expect(body.tools).toHaveLength(10);
    expect(body.tools.map((t) => t.name)).toContain('diagnose_incident');
  });

  it('POST /ai/probe returns the probe results', async () => {
    const before = probeCalls;
    const response = await fetch(`${baseUrl}/ai/probe`, { method: 'POST' });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      probes: ProbeResult[];
      applied: boolean;
      provider: string | null;
      wouldSelect: string | null;
    };

    expect(body.probes).toHaveLength(3);
    expect(body.probes[0]?.status).toBe('ok');
    // The probe actually ran.
    expect(probeCalls).toBe(before + 1);
  });

  it('POST /ai/probe does not change the provider in use', async () => {
    const response = await fetch(`${baseUrl}/ai/probe`, { method: 'POST' });
    const body = (await response.json()) as { applied: boolean; provider: string | null };

    // It says so explicitly.
    expect(body.applied).toBe(false);
    // And the provider is unchanged.
    expect(body.provider).toBe('anthropic');

    // The health endpoint still reports the same provider.
    const health = (await (
      await fetch(`${baseUrl}/health`)
    ).json()) as HealthBody;
    expect(health.ai.provider).toBe('anthropic');
  });
});

describe('the health endpoint without a provider', () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createApiRouter({
        registry: new ToolRegistry().registerAll(createTools()),
        provider: null,
        systemPrompt: 'test',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
        ai: {
          enabled: false,
          provider: null,
          model: null,
          mode: 'auto',
          selectedAt: '2026-10-21T10:00:00.000Z',
          probes: [
            { provider: 'anthropic', status: 'not_configured', ok: false, latencyMs: 0 },
            { provider: 'openai', status: 'not_configured', ok: false, latencyMs: 0 },
            { provider: 'gemini', status: 'not_configured', ok: false, latencyMs: 0 },
          ],
        },
      }),
    );

    httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('reports enabled false and every provider not_configured', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as HealthBody;

    expect(body.ai.enabled).toBe(false);
    expect(body.ai.provider).toBeNull();
    expect(body.ai.probes?.map((p) => p.status)).toEqual([
      'not_configured',
      'not_configured',
      'not_configured',
    ]);
  });
});
