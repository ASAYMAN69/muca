import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import {
  formatDecision,
  gatewayInput,
  selectProvider,
  type GatewayInput,
} from '../src/ai/gateway.js';
import {
  classifyResponse,
  isConfigured,
  probeProviders,
  type ProbeFetch,
  type ProbeFetchResponse,
  type ProbeStatus,
} from '../src/ai/probe.js';


/** Builds a `ProcessEnv`-shaped object for the config tests. */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...values };
}

/**
 * The provider gateway.
 *
 * Every test here is **offline**: the fetch is injected, so no endpoint is
 * ever contacted.
 */

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A fetch that answers with a fixed status. */
function stubFetch(
  status: number,
  options: { delayMs?: number; throwError?: Error } = {},
): ProbeFetch {
  return async () => {
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    if (options.throwError) throw options.throwError;
    const response: ProbeFetchResponse = {
      ok: status >= 200 && status < 300,
      status,
      text: async () => '',
    };
    return response;
  };
}

/** A fetch that answers per-URL. */
function stubFetchByHost(
  handlers: Record<string, { status: number; delayMs?: number }>,
): { fetchImpl: ProbeFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: ProbeFetch = async (url) => {
    calls.push(url);
    const key = Object.keys(handlers).find((k) => url.includes(k)) ?? '';
    const handler = handlers[key] ?? { status: 500 };
    if (handler.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, handler.delayMs));
    }
    return {
      ok: handler.status >= 200 && handler.status < 300,
      status: handler.status,
      text: async () => '',
    };
  };
  return { fetchImpl, calls };
}

function input(overrides: Partial<GatewayInput> = {}): GatewayInput {
  return {
    requested: 'auto',
    anthropic: { apiKey: 'sk-ant-key', endpoint: 'https://anthropic.test', model: 'claude-test' },
    openai: { apiKey: 'sk-openai-key', endpoint: 'https://openai.test/v1', model: 'gpt-test' },
    gemini: { apiKey: 'gemini-key', endpoint: 'https://gemini.test/v1beta', model: 'gemini-test' },
    timeoutMs: 1000,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

describe('the gateway configuration', () => {
  it('defaults AI_PROVIDER to auto', () => {
    const config = loadConfig(env({}));
    expect(config.ai.requested).toBe('auto');
    expect(config.ai.mode).toBe('auto');
  });

  it('reads every provider block', () => {
    const config = loadConfig(env({
      ANTHROPIC_API_KEY: 'ant-key',
      ANTHROPIC_ENDPOINT: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'claude-x',
      OPENAI_API_KEY: 'oai-key',
      OPENAI_ENDPOINT: 'https://openai.test/v1',
      OPENAI_MODEL: 'gpt-x',
      GEMINI_API_KEY: 'gem-key',
    }));

    expect(config.ai.anthropic.apiKey).toBe('ant-key');
    expect(config.ai.anthropic.model).toBe('claude-x');
    expect(config.ai.openai.apiKey).toBe('oai-key');
    expect(config.ai.openai.model).toBe('gpt-x');
    expect(config.ai.gemini.apiKey).toBe('gem-key');
  });

  it('gives Gemini working endpoint and model defaults', () => {
    const config = loadConfig(env({}));
    expect(config.ai.gemini.endpoint).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    );
    expect(config.ai.gemini.model).toBeTruthy();
  });

  it('keeps OPENAI_BASE_URL working as a deprecated alias', () => {
    const config = loadConfig(env({
      OPENAI_BASE_URL: 'https://legacy.test/v1',
    }));
    expect(config.ai.openai.endpoint).toBe('https://legacy.test/v1');
  });

  it('lets the new OPENAI_ENDPOINT name win over the alias', () => {
    const config = loadConfig(env({
      OPENAI_BASE_URL: 'https://legacy.test/v1',
      OPENAI_ENDPOINT: 'https://new.test/v1',
    }));
    expect(config.ai.openai.endpoint).toBe('https://new.test/v1');
  });

  it('reads the probe timeout', () => {
    // An explicit value wins.
    expect(
      loadConfig(env({ AI_PROBE_TIMEOUT_MS: '2500' })).ai.probeTimeoutMs,
    ).toBe(2500);

    // Without one, the schema's default applies. It is read from the
    // schema rather than hardcoded here, so the two cannot drift.
    const fallback = loadConfig(env({})).ai.probeTimeoutMs;
    expect(fallback).toBe(10_000);
    expect(fallback).toBe(
      loadConfig(env({ AI_PROBE_TIMEOUT_MS: String(fallback) }))
        .ai.probeTimeoutMs,
    );
  });

  it('treats an Anthropic key without a model as not configured', () => {
    const config = loadConfig(env({ ANTHROPIC_API_KEY: 'ant-key' }));
    expect(config.ai.anthropic.model).toBe('');
    expect(isConfigured('anthropic', config.ai.anthropic)).toBe(false);
  });

  it('treats a provider with a key and a model as configured', () => {
    const config = loadConfig(env({
      ANTHROPIC_API_KEY: 'ant-key',
      ANTHROPIC_MODEL: 'claude-x',
    }));
    expect(isConfigured('anthropic', config.ai.anthropic)).toBe(true);
  });

  it('treats a provider with no key as not configured', () => {
    const config = loadConfig(env({}));
    expect(isConfigured('openai', config.ai.openai)).toBe(false);
    expect(isConfigured('gemini', config.ai.gemini)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Probe classification                                                       */
/* -------------------------------------------------------------------------- */

describe('probe classification', () => {
  const status = (code: number): ProbeStatus =>
    classifyResponse('openai', { ok: code >= 200 && code < 300, status: code, text: async () => '' });

  it('treats 2xx as ok', () => {
    expect(status(200)).toBe('ok');
    expect(status(201)).toBe('ok');
  });

  it('treats 429 as throttled', () => {
    expect(status(429)).toBe('throttled');
  });

  it('treats 401 and 403 as an invalid key', () => {
    expect(status(401)).toBe('invalid_key');
    expect(status(403)).toBe('invalid_key');
  });

  it('treats other 4xx as a bad request', () => {
    expect(status(400)).toBe('bad_request');
    expect(status(404)).toBe('bad_request');
  });

  it('treats 5xx as unreachable', () => {
    expect(status(500)).toBe('unreachable');
    expect(status(503)).toBe('unreachable');
  });
});

/* -------------------------------------------------------------------------- */
/* Probing                                                                    */
/* -------------------------------------------------------------------------- */

describe('probing', () => {
  it('sends no request when the provider is not configured', async () => {
    const fetchImpl = vi.fn(stubFetch(200));
    const results = await probeProviders(
      [{ provider: 'openai', config: { apiKey: '', endpoint: 'https://x', model: 'm' } }],
      { timeoutMs: 1000, fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(results[0]?.status).toBe('not_configured');
    expect(results[0]?.ok).toBe(false);
  });

  it('sends the key in a header, never in the URL', async () => {
    const { fetchImpl, calls } = stubFetchByHost({ 'openai.test': { status: 200 } });
    await probeProviders(
      [{ provider: 'openai', config: { apiKey: 'sk-secret-key', endpoint: 'https://openai.test/v1', model: 'm' } }],
      { timeoutMs: 1000, fetchImpl },
    );

    expect(calls[0]).not.toContain('sk-secret-key');
    expect(calls[0]).toBe('https://openai.test/v1/chat/completions');
  });

  it('classifies a 429 as usable', async () => {
    const results = await probeProviders(
      [{ provider: 'openai', config: { apiKey: 'k', endpoint: 'https://x', model: 'm' } }],
      { timeoutMs: 1000, fetchImpl: stubFetch(429) },
    );

    expect(results[0]?.status).toBe('throttled');
    expect(results[0]?.ok).toBe(true);
  });

  it('classifies a 401 as not usable', async () => {
    const results = await probeProviders(
      [{ provider: 'openai', config: { apiKey: 'k', endpoint: 'https://x', model: 'm' } }],
      { timeoutMs: 1000, fetchImpl: stubFetch(401) },
    );

    expect(results[0]?.status).toBe('invalid_key');
    expect(results[0]?.ok).toBe(false);
  });

  it('classifies a network error as unreachable', async () => {
    const results = await probeProviders(
      [{ provider: 'openai', config: { apiKey: 'k', endpoint: 'https://x', model: 'm' } }],
      {
        timeoutMs: 1000,
        fetchImpl: stubFetch(0, { throwError: new Error('ECONNREFUSED') }),
      },
    );

    expect(results[0]?.status).toBe('unreachable');
    expect(results[0]?.ok).toBe(false);
  });

  it('never puts a key in an error message', async () => {
    const results = await probeProviders(
      [
        {
          provider: 'openai',
          config: { apiKey: 'sk-verysecretvalue123', endpoint: 'https://x', model: 'm' },
        },
      ],
      {
        timeoutMs: 1000,
        fetchImpl: stubFetch(0, {
          throwError: new Error('failed with sk-verysecretvalue123 in the message'),
        }),
      },
    );

    expect(results[0]?.detail ?? '').not.toContain('sk-verysecretvalue123');
  });

  it('times out a provider that never answers', async () => {
    const results = await probeProviders(
      [{ provider: 'openai', config: { apiKey: 'k', endpoint: 'https://x', model: 'm' } }],
      {
        timeoutMs: 30,
        fetchImpl: async (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      },
    );

    expect(results[0]?.status).toBe('timeout');
    expect(results[0]?.ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Parallelism                                                                */
/* -------------------------------------------------------------------------- */

describe('the probes run in parallel', () => {
  it('starts every probe before any of them resolves', async () => {
    const started: string[] = [];
    const settled: string[] = [];

    const fetchImpl: ProbeFetch = async (url) => {
      const host = url.includes('anthropic') ? 'anthropic' : url.includes('openai') ? 'openai' : 'gemini';
      started.push(host);
      // The first provider started is the slowest to answer.
      const delay = host === 'anthropic' ? 60 : 5;
      await new Promise((resolve) => setTimeout(resolve, delay));
      settled.push(host);
      return { ok: true, status: 200, text: async () => '' };
    };

    const results = await probeProviders(
      [
        { provider: 'anthropic', config: { apiKey: 'a', endpoint: 'https://anthropic.test', model: 'm' } },
        { provider: 'openai', config: { apiKey: 'o', endpoint: 'https://openai.test/v1', model: 'm' } },
        { provider: 'gemini', config: { apiKey: 'g', endpoint: 'https://gemini.test/v1beta', model: 'm' } },
      ],
      { timeoutMs: 1000, fetchImpl },
    );

    // All three were started before the first one settled.
    expect(started).toHaveLength(3);
    expect(settled[0]).not.toBe('anthropic');
    expect(results).toHaveLength(3);
  });

  it('does not let a slow provider delay the others', async () => {
    // Anthropic hangs; OpenAI answers immediately.
    const fetchImpl: ProbeFetch = async (url, init) => {
      if (url.includes('anthropic')) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return { ok: true, status: 200, text: async () => '' };
    };

    const startedAt = Date.now();
    const results = await probeProviders(
      [
        { provider: 'anthropic', config: { apiKey: 'a', endpoint: 'https://anthropic.test', model: 'm' } },
        { provider: 'openai', config: { apiKey: 'o', endpoint: 'https://openai.test/v1', model: 'm' } },
      ],
      { timeoutMs: 200, fetchImpl },
    );

    // The whole set settled in about the timeout, not timeout + timeout.
    expect(Date.now() - startedAt).toBeLessThan(600);

    const openai = results.find((r) => r.provider === 'openai');
    expect(openai?.status).toBe('ok');
    expect(openai?.ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

describe('provider selection', () => {
  it('picks Anthropic when both Anthropic and OpenAI are usable', async () => {
    const decision = await selectProvider(input(), stubFetch(200));
    expect(decision.selected).toBe('anthropic');
    expect(decision.enabled).toBe(true);
    expect(decision.model).toBe('claude-test');
  });

  it('picks OpenAI when only OpenAI is usable', async () => {
    const decision = await selectProvider(
      input(),
      stubFetchByHost({
        'anthropic.test': { status: 401 },
        'openai.test': { status: 200 },
      }).fetchImpl,
    );
    expect(decision.selected).toBe('openai');
    expect(decision.enabled).toBe(true);
  });

  it('picks Gemini when only Gemini is usable', async () => {
    const decision = await selectProvider(
      input(),
      stubFetchByHost({
        'anthropic.test': { status: 401 },
        'openai.test': { status: 401 },
        'gemini.test': { status: 200 },
      }).fetchImpl,
    );
    expect(decision.selected).toBe('gemini');
    expect(decision.enabled).toBe(true);
  });

  it('picks nothing when no provider is usable', async () => {
    const decision = await selectProvider(input(), stubFetch(401));
    expect(decision.selected).toBeNull();
    expect(decision.enabled).toBe(false);
    expect(decision.model).toBeNull();
  });

  it('treats a throttled provider as usable', async () => {
    const decision = await selectProvider(
      input(),
      stubFetchByHost({
        'anthropic.test': { status: 429 },
        'openai.test': { status: 200 },
      }).fetchImpl,
    );
    // Anthropic is higher priority, and 429 counts as usable.
    expect(decision.selected).toBe('anthropic');
  });

  it('does not pick a provider that failed its probe', async () => {
    const decision = await selectProvider(
      input(),
      stubFetchByHost({
        'anthropic.test': { status: 401 },
        'openai.test': { status: 401 },
        'gemini.test': { status: 500 },
      }).fetchImpl,
    );
    expect(decision.selected).toBeNull();
    expect(decision.enabled).toBe(false);
  });

  it('skips a provider that is not configured', async () => {
    const decision = await selectProvider(
      input({
        anthropic: { apiKey: '', endpoint: 'https://anthropic.test', model: '' },
      }),
      stubFetch(200),
    );
    expect(decision.selected).toBe('openai');
    const anthropic = decision.probes.find((p) => p.provider === 'anthropic');
    expect(anthropic?.status).toBe('not_configured');
  });

  it('reports the probes in priority order', async () => {
    const decision = await selectProvider(input(), stubFetch(200));
    expect(decision.probes.map((p) => p.provider)).toEqual([
      'anthropic',
      'openai',
      'gemini',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Explicit mode                                                              */
/* -------------------------------------------------------------------------- */

describe('explicit mode', () => {
  it('uses the named provider and does not fall back', async () => {
    const decision = await selectProvider(
      input({ requested: 'openai' }),
      stubFetchByHost({
        'anthropic.test': { status: 200 },
        'openai.test': { status: 401 },
      }).fetchImpl,
    );

    // OpenAI failed, so there is no provider — even though Anthropic works.
    expect(decision.selected).toBeNull();
    expect(decision.enabled).toBe(false);
  });

  it('probes only the named provider', async () => {
    const { fetchImpl, calls } = stubFetchByHost({
      'anthropic.test': { status: 200 },
      'openai.test': { status: 200 },
    });
    await selectProvider(input({ requested: 'openai' }), fetchImpl);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('openai.test');
  });

  it('uses the named provider when it is usable', async () => {
    const decision = await selectProvider(
      input({ requested: 'gemini' }),
      stubFetchByHost({
        'anthropic.test': { status: 200 },
        'openai.test': { status: 200 },
        'gemini.test': { status: 200 },
      }).fetchImpl,
    );
    expect(decision.selected).toBe('gemini');
  });

  it('marks the mode as explicit', () => {
    const config = loadConfig(env({ AI_PROVIDER: 'openai' }));
    expect(config.ai.mode).toBe('explicit');
    expect(gatewayInput(config).requested).toBe('openai');
  });
});

/* -------------------------------------------------------------------------- */
/* The decision summary                                                       */
/* -------------------------------------------------------------------------- */

describe('the decision summary', () => {
  it('names the mode, the choice and every probe', async () => {
    const decision = await selectProvider(
      input(),
      stubFetchByHost({
        'anthropic.test': { status: 200 },
        'openai.test': { status: 200 },
        'gemini.test': { status: 429 },
      }).fetchImpl,
    );

    const line = formatDecision('auto', decision);
    expect(line).toContain('auto');
    expect(line).toContain('anthropic');
    expect(line).toContain('claude-test');
    expect(line).toContain('probes:');
  });

  it('never contains a key', async () => {
    const decision = await selectProvider(input(), stubFetch(200));
    const line = formatDecision('auto', decision);
    expect(line).not.toContain('sk-ant-key');
    expect(line).not.toContain('sk-openai-key');
    expect(line).not.toContain('gemini-key');
  });

  it('says so when there is no usable provider', async () => {
    const decision = await selectProvider(input(), stubFetch(401));
    const line = formatDecision('auto', decision);
    expect(line).toContain('none');
  });
});
