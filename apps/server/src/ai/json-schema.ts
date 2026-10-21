import { z } from 'zod';

/**
 * Provider-safe JSON Schema.
 *
 * Zod v4 can emit a complete JSON Schema document, but a model provider
 * does not accept a complete JSON Schema document: it accepts a **schema
 * dialect**, and rejects the keywords that are not part of that dialect.
 *
 * This is not theoretical. Against the live Google Gemini API, a tool
 * whose parameters carried Zod's `$schema` keyword was rejected:
 *
 * ```
 * Invalid JSON payload received. Unknown name "$schema" at
 * 'tools[0].function_declarations[0].parameters': Cannot find field.
 * ```
 *
 * The request failed with HTTP 400 — every tool-calling request, on
 * every run. The probe still passed, because the probe sends no tools.
 *
 * The keyword list below was determined empirically against the live API,
 * not guessed: each candidate was sent and the API's own "Unknown name"
 * errors were read back.
 *
 * Two rules are applied:
 *
 *   1. **Drop** keywords that carry no meaning for a model and that the
 *      dialect rejects — `$schema`, `$id`, `$ref`, and the rest.
 *   2. **Translate** keywords that do carry meaning into an equivalent
 *      the dialect accepts — `const` becomes a single-value `enum`, and
 *      `exclusiveMinimum` / `exclusiveMaximum` become `minimum` /
 *      `maximum`.
 */

/**
 * Keywords that the provider schema dialect rejects.
 *
 * Every one of these is JSON-Schema-only bookkeeping: none of them
 * changes what the model should pass, so dropping them loses nothing.
 */
const DROPPED_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'contains',
  'contentEncoding',
  'contentMediaType',
  'dependentRequired',
  'dependentSchemas',
  'else',
  'examples',
  'if',
  'multipleOf',
  'patternProperties',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedProperties',
  'uniqueItems',
]);

/**
 * Converts a Zod object schema into a provider-safe JSON Schema.
 *
 * `io: 'input'` matches what the MCP SDK publishes for tool input schemas:
 * defaults are treated as optional inputs.
 */
export function toProviderJsonSchema(
  schema: z.ZodObject<z.ZodRawShape>,
): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  return sanitiseSchema(raw) as Record<string, unknown>;
}

/**
 * Rewrites a JSON Schema into the provider dialect.
 *
 * The input is not modified.
 */
export function sanitiseSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitiseSchema);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const source = value as Record<string, unknown>;

  // The exclusive bounds are translated before the object is rebuilt, so
  // that a translated value cannot be overwritten by an explicit one that
  // happens to be visited later.
  const minimum = pickBound(source, 'minimum', 'exclusiveMinimum');
  const maximum = pickBound(source, 'maximum', 'exclusiveMaximum');

  const result: Record<string, unknown> = {};

  for (const [key, child] of Object.entries(source)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === 'minimum' || key === 'maximum') continue;
    if (key === 'exclusiveMinimum' || key === 'exclusiveMaximum') continue;
    if (key === 'const') {
      // A single allowed value is exactly a one-value enum.
      result.enum = [child];
      continue;
    }

    result[key] = sanitiseSchema(child);
  }

  if (minimum !== undefined) result.minimum = minimum;
  if (maximum !== undefined) result.maximum = maximum;

  return result;
}

/**
 * Chooses the bound to publish.
 *
 * An explicit `minimum` wins over `exclusiveMinimum`; when both are
 * present the stricter (larger) value is kept, because that is the
 * constraint the tool actually enforces.
 */
function pickBound(
  source: Record<string, unknown>,
  inclusive: 'minimum' | 'maximum',
  exclusive: 'exclusiveMinimum' | 'exclusiveMaximum',
): number | undefined {
  const inclusiveValue = asNumber(source[inclusive]);
  const exclusiveValue = asNumber(source[exclusive]);

  if (inclusiveValue === undefined) return exclusiveValue;
  if (exclusiveValue === undefined) return inclusiveValue;

  return inclusive === 'minimum'
    ? Math.max(inclusiveValue, exclusiveValue)
    : Math.min(inclusiveValue, exclusiveValue);
}

/** Reads a value as a number, if it is one. */
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
