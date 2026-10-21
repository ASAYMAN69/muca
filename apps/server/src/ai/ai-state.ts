import type { AiProviderName } from '../config.js';
import type { ProbeResult } from './probe.js';

/**
 * The gateway's state, reported by `GET /api/v1/health`.
 *
 * It lives in its own module so both the HTTP layer and the server
 * wiring can depend on it without importing each other.
 */
export interface AiState {
  /** True when a usable provider was found. */
  enabled: boolean;
  /** The provider in use, or null when none is usable. */
  provider: AiProviderName | null;
  /** The model of the provider in use. */
  model: string | null;
  /** `auto` when the gateway chose, `explicit` when the operator did. */
  mode: 'auto' | 'explicit';
  /** When the provider was selected. */
  selectedAt: string;
  /** The probe results for every provider that was considered. */
  probes: ProbeResult[];
}
