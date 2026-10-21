import type { AiProviderName, AppConfig, ProviderConfig } from '../config.js';
import {
  PROBE_PRIORITY,
  probeProviders,
  type ProbeFetch,
  type ProbeResult,
} from './probe.js';

/**
 * The provider gateway.
 *
 * Muca should work whichever AI key the operator happens to have. The
 * gateway probes every configured endpoint in parallel at startup and
 * uses the highest-priority one that actually answers.
 *
 * Two modes:
 *
 *   - **auto** — the first usable provider in priority order wins
 *     (anthropic > openai > gemini).
 *   - **explicit** — the operator named a provider, so that one is used
 *     and *only* that one. If it is not usable the server runs without a
 *     model rather than silently switching. Predictability beats
 *     cleverness when the operator has been explicit.
 */

/** The outcome of the gateway's decision. */
export interface GatewayDecision {
  /** The provider in use, or null when none is usable. */
  selected: AiProviderName | null;
  /** The model of the selected provider. */
  model: string | null;
  /** True when a usable provider was found. */
  enabled: boolean;
  /** The probe result for every provider that was considered. */
  probes: ProbeResult[];
}

/** The gateway's inputs. */
export interface GatewayInput {
  requested: AiProviderName | 'auto';
  anthropic: ProviderConfig;
  openai: ProviderConfig;
  gemini: ProviderConfig;
  timeoutMs: number;
}

/** The configuration a provider needs to be probed. */
export function providerConfig(
  input: GatewayInput,
  provider: AiProviderName,
): ProviderConfig {
  switch (provider) {
    case 'anthropic':
      return input.anthropic;
    case 'openai':
      return input.openai;
    case 'gemini':
      return input.gemini;
    case 'bedrock':
      // Bedrock is not probed, so it has no HTTP configuration. An empty
      // configuration is enough to keep the switch total.
      return { apiKey: '', endpoint: '', model: '' };
  }
}

/**
 * Runs the probes and decides which provider to use.
 *
 * @param fetchImpl Injected for the tests; the global `fetch` by default.
 */
export async function selectProvider(
  input: GatewayInput,
  fetchImpl?: ProbeFetch,
): Promise<GatewayDecision> {
  // In explicit mode only the named provider is probed. Everything else
  // is reported as `not_configured` so the health output is complete.
  if (input.requested !== 'auto') {
    const provider = input.requested;
    const config = providerConfig(input, provider);
    const results = await probeProviders(
      [{ provider, config }],
      { timeoutMs: input.timeoutMs, fetchImpl },
    );

    // The other providers were never considered.
    const others = PROBE_PRIORITY.filter((p) => p !== provider).map((p) => ({
      provider: p,
      status: 'not_configured' as const,
      ok: false,
      latencyMs: 0,
      detail: 'Not selected: the operator named a provider explicitly.',
    }));

    const result = results[0];
    const usable = result?.ok === true;

    return {
      selected: usable ? provider : null,
      model: usable ? config.model : null,
      enabled: usable,
      probes: [result, ...others].filter(Boolean) as ProbeResult[],
    };
  }

  // Auto: probe every configured provider, in parallel.
  const targets = PROBE_PRIORITY.map((provider) => ({
    provider,
    config: providerConfig(input, provider),
  }));

  const probes = await probeProviders(targets, {
    timeoutMs: input.timeoutMs,
    fetchImpl,
  });

  // The first provider in priority order whose status is usable wins.
  const winner = PROBE_PRIORITY.map((provider) =>
    probes.find((probe) => probe.provider === provider),
  ).find((probe) => probe?.ok === true);

  const selected = winner?.provider ?? null;

  return {
    selected,
    model: selected ? providerConfig(input, selected).model : null,
    enabled: selected !== null,
    probes,
  };
}

/**
 * A one-line summary of the decision, for the startup log.
 *
 * It never contains a key.
 */
export function formatDecision(
  requested: AiProviderName | 'auto',
  decision: GatewayDecision,
): string {
  const mode = requested === 'auto' ? 'auto' : 'explicit';
  const chosen = decision.selected
    ? `${decision.selected} (${decision.model ?? 'default model'})`
    : 'none — the server will run without a model';

  const probes = decision.probes
    .map((probe) => `${probe.provider} ${probe.status}${probe.latencyMs ? ` ${probe.latencyMs}ms` : ''}`)
    .join(' · ');

  return `AI gateway  ${mode} → ${chosen}  probes: ${probes}`;
}

/**
 * Builds the gateway input from the application configuration.
 */
export function gatewayInput(config: AppConfig): GatewayInput {
  return {
    requested: config.ai.requested,
    anthropic: config.ai.anthropic,
    openai: config.ai.openai,
    gemini: config.ai.gemini,
    timeoutMs: config.ai.probeTimeoutMs,
  };
}
