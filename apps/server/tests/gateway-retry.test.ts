import { describe, expect, it } from 'vitest';

import { selectProvider, type GatewayInput } from '../src/ai/gateway.js';
import type { ProbeFetch, ProbeFetchResponse } from '../src/ai/probe.js';

/**
 * A transient network error at boot must not disable the agent for the
 * life of the process.
 *
 * The server starts Next.js and the rest of the stack at the same moment
 * as the probes. On a cold machine that was enough for a healthy endpoint
 * to answer as `unreachable`, and the agent was then disabled until the
 * server was restarted.
 */
describe('the gateway retries when nothing answered', () => {
  function input(overrides: Partial<GatewayInput> = {}): GatewayInput {
    return {
      requested: 'auto',
      timeoutMs: 1_000,
      anthropic: {
        apiKey: 'sk-ant-test',
        endpoint: 'https://anthropic.test',
        model: 'claude-test',
      },
      openai: { apiKey: '', endpoint: '', model: '' },
      gemini: { apiKey: '', endpoint: '', model: '' },
      ...overrides,
    } as GatewayInput;
  }

  it('probes again when the first round found nothing', async () => {
    let calls = 0;
    const fetchImpl: ProbeFetch = async () => {
      calls += 1;
      // The first attempt hits a transient network error; the second works.
      if (calls === 1) throw new Error('ECONNRESET');
      const response: ProbeFetchResponse = {
        ok: true,
        status: 200,
        text: async () => '',
      };
      return response;
    };

    const decision = await selectProvider(input(), fetchImpl);

    expect(calls).toBeGreaterThan(1);
    expect(decision.enabled).toBe(true);
    expect(decision.selected).toBe('anthropic');
  });

  it('keeps the round that answered', async () => {
    let calls = 0;
    const fetchImpl: ProbeFetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return { ok: true, status: 200, text: async () => '' };
    };

    const decision = await selectProvider(input(), fetchImpl);

    const probe = decision.probes.find((p) => p.provider === 'anthropic');
    expect(probe?.ok).toBe(true);
    expect(probe?.status).toBe('ok');
  });

  it('does not probe twice when the first round already answered', async () => {
    let calls = 0;
    const fetchImpl: ProbeFetch = async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => '' };
    };

    const decision = await selectProvider(input(), fetchImpl);

    expect(calls).toBe(1);
    expect(decision.selected).toBe('anthropic');
  });

  it('still gives up when nothing ever answers', async () => {
    const fetchImpl: ProbeFetch = async () => {
      throw new Error('ECONNRESET');
    };

    const decision = await selectProvider(input(), fetchImpl);

    expect(decision.enabled).toBe(false);
    expect(decision.selected).toBeNull();
  });
});
