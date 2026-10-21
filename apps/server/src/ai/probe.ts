import type { AiProviderName, ProviderConfig } from '../config.js';

/**
 * The provider probe.
 *
 * Muca should work whichever AI key the operator happens to have. At
 * startup the server sends a **minimal real request** to every configured
 * endpoint, concurrently, and uses the highest-priority one that actually
 * answers.
 *
 * The probe is deliberately more than a boolean. A provider that answers
 * `429 Too Many Requests` has a *working* key — it is just rate-limited at
 * this moment — and refusing to start because of a transient 429 would be
 * worse than trying. A provider that answers `401` has a broken key and
 * will not work.
 */

/** The status of one probe. */
export type ProbeStatus =
  | 'ok'
  | 'throttled'
  | 'invalid_key'
  | 'bad_request'
  | 'unreachable'
  | 'timeout'
  | 'not_configured';

/** The result of probing one provider. */
export interface ProbeResult {
  provider: AiProviderName;
  status: ProbeStatus;
  /** True when the provider is usable (a 429 still counts). */
  ok: boolean;
  /** How long the probe took, in milliseconds. */
  latencyMs: number;
  /** A short, safe description. Never contains a key. */
  detail?: string;
}

/** The providers the gateway probes, in priority order. */
export const PROBE_PRIORITY: readonly AiProviderName[] = [
  'anthropic',
  'openai',
  'gemini',
];

/**
 * The function used to make a request. Injected so the tests never touch
 * the network.
 */
export type ProbeFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<ProbeFetchResponse>;

/** The minimal shape of a `fetch` response the probe needs. */
export interface ProbeFetchResponse {
  ok: boolean;
  status: number;
  /** Read the body, if there is one. */
  text(): Promise<string>;
}

/** The configuration a probe needs. */
export interface ProbeTarget {
  provider: AiProviderName;
  config: ProviderConfig;
}

/** How long a probe may take. */
export interface ProbeOptions {
  timeoutMs: number;
  /** Injected for the tests. Defaults to the global `fetch`. */
  fetchImpl?: ProbeFetch;
}

/**
 * Is this provider configured at all?
 *
 * A provider needs a key. Anthropic additionally needs a model: there is
 * no safe default model id, so the operator must name one.
 */
export function isConfigured(provider: AiProviderName, config: ProviderConfig): boolean {
  if (!config.apiKey) return false;
  if (provider === 'anthropic' && !config.model) return false;
  return true;
}

/**
 * Probes every configured provider **in parallel**.
 *
 * All probes are started before any of them is awaited, so one slow
 * provider never delays the others. Each probe has its own abort
 * controller and the whole set is bounded by `timeoutMs`.
 */
export async function probeProviders(
  targets: ProbeTarget[],
  options: ProbeOptions,
): Promise<ProbeResult[]> {
  const fetchImpl = options.fetchImpl ?? (defaultFetch as ProbeFetch);

  // Start every probe first, then await them together. `allSettled` so
  // one rejection cannot cancel the others.
  const settled = await Promise.allSettled(
    targets.map((target) =>
      probeProvider(target, { ...options, fetchImpl }),
    ),
  );

  const results: ProbeResult[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      results.push(outcome.value);
    } else {
      // `probeProvider` never rejects, so this is a belt-and-braces guard.
      results.push({
        provider: 'openai',
        status: 'unreachable',
        ok: false,
        latencyMs: 0,
        detail: 'The probe failed unexpectedly.',
      });
    }
  }

  // Report in priority order, whatever order they settled in.
  const order = new Map(PROBE_PRIORITY.map((p, i) => [p, i]));
  return results.sort(
    (a, b) => (order.get(a.provider) ?? 99) - (order.get(b.provider) ?? 99),
  );
}

/** Probes a single provider. Never rejects. */
export async function probeProvider(
  target: ProbeTarget,
  options: ProbeOptions & { fetchImpl: ProbeFetch },
): Promise<ProbeResult> {
  const { provider, config } = target;

  if (!isConfigured(provider, config)) {
    return {
      provider,
      status: 'not_configured',
      ok: false,
      latencyMs: 0,
      detail: 'No API key configured.',
    };
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  // A pending probe must not hold the process open.
  timer.unref?.();

  try {
    const { url, init } = buildProbeRequest(provider, config);
    const response = await options.fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;
    const status = classifyResponse(provider, response);

    // Read the body so the connection is released; it is never logged.
    await response.text().catch(() => '');

    return {
      provider,
      status,
      ok: status === 'ok' || status === 'throttled',
      latencyMs,
      detail: describeStatus(status),
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (timedOut) {
      return {
        provider,
        status: 'timeout',
        ok: false,
        latencyMs,
        detail: `No answer within ${options.timeoutMs}ms.`,
      };
    }
    return {
      provider,
      status: 'unreachable',
      ok: false,
      latencyMs,
      // The message is sanitised: it never contains a key.
      detail: safeErrorMessage(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classifies an HTTP response into a probe status.
 *
 * A 429 is **usable**: the key is valid, it is just rate-limited.
 */
export function classifyResponse(
  provider: AiProviderName,
  response: ProbeFetchResponse,
): ProbeStatus {
  if (response.ok) return 'ok';

  const status = response.status;
  if (status === 429) return 'throttled';
  if (status === 401 || status === 403) return 'invalid_key';
  if (status >= 400 && status < 500) return 'bad_request';
  // A 5xx is not a key problem, but it is not a working endpoint either.
  return 'unreachable';
}

/** Builds the minimal request for a provider's probe. */
function buildProbeRequest(
  provider: AiProviderName,
  config: ProviderConfig,
): { url: string; init: { method: string; headers: Record<string, string>; body: string } } {
  if (provider === 'anthropic') {
    return {
      url: `${config.endpoint}/v1/messages`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    };
  }

  if (provider === 'openai') {
    return {
      url: `${config.endpoint}/chat/completions`,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    };
  }

  // Gemini.
  return {
    url: `${config.endpoint}/models/${config.model}:generateContent`,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    },
  };
}

/** A short, safe description of a status. */
function describeStatus(status: ProbeStatus): string {
  switch (status) {
    case 'ok':
      return 'The endpoint answered.';
    case 'throttled':
      return 'Rate limited (429) — the key works.';
    case 'invalid_key':
      return 'The key was rejected (401/403).';
    case 'bad_request':
      return 'The endpoint rejected the request (4xx) — check the model and endpoint.';
    case 'unreachable':
      return 'The endpoint could not be reached.';
    case 'timeout':
      return 'The endpoint did not answer in time.';
    case 'not_configured':
      return 'No API key configured.';
  }
}

/**
 * A sanitised error message.
 *
 * It never contains a key: only the error's own text, with anything that
 * looks like a key redacted.
 */
function safeErrorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error.';
  // Redact anything that looks like a secret.
  return raw
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/AIza[A-Za-z0-9_-]{10,}/g, 'AIza[redacted]')
    .slice(0, 200);
}

/** The default `fetch`, adapted to the narrow interface the probe needs. */
const defaultFetch: ProbeFetch = async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};
