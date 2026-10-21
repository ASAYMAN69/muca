import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sanitiseSchema, toProviderJsonSchema } from '../src/ai/json-schema.js';
import { Agent } from '../src/ai/agent.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import type { AIProvider, ProviderResponse } from '../src/ai/provider.js';

class NoopProvider implements AIProvider {
  readonly name = 'noop';
  async chat(): Promise<ProviderResponse> {
    return { content: 'ok', toolCalls: [], finishReason: 'stop' };
  }
}

/**
 * A provider rejects the JSON Schema that Zod emits, because a provider
 * accepts a schema *dialect* rather than a complete JSON Schema document.
 *
 * Against the live Google Gemini API, a tool whose parameters carried
 * Zod's `$schema` keyword was rejected with HTTP 400:
 *
 *   Invalid JSON payload received. Unknown name "$schema" at
 *   'tools[0].function_declarations[0].parameters': Cannot find field.
 *
 * The keyword list in `json-schema.ts` was determined empirically against
 * that API, not guessed. These tests lock the behaviour in.
 */
describe('provider-safe JSON Schema', () => {
  it('drops the $schema keyword', () => {
    const schema = toProviderJsonSchema(z.object({ a: z.string() }));
    expect(schema).not.toHaveProperty('$schema');
    expect(schema.type).toBe('object');
  });

  it('translates an exclusive minimum into a plain minimum', () => {
    const schema = toProviderJsonSchema(
      z.object({ limit: z.number().int().positive().optional() }),
    );
    const limit = (schema.properties as Record<string, Record<string, unknown>>)
      .limit!;
    expect(limit.minimum).toBe(0);
    expect(limit).not.toHaveProperty('exclusiveMinimum');
  });

  it('keeps the stricter bound when both are present', () => {
    const result = sanitiseSchema({
      type: 'number',
      minimum: 5,
      exclusiveMinimum: 10,
    }) as Record<string, unknown>;
    expect(result.minimum).toBe(10);
  });

  it('translates a const into a single-value enum', () => {
    const result = sanitiseSchema({ type: 'string', const: 'fixed' }) as Record<
      string,
      unknown
    >;
    expect(result.enum).toEqual(['fixed']);
    expect(result).not.toHaveProperty('const');
  });

  it('drops the JSON Schema keywords a provider rejects', () => {
    const result = sanitiseSchema({
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'x',
      additionalProperties: false,
      examples: ['x'],
      uniqueItems: true,
      properties: {
        a: { type: 'string', pattern: '^a', minLength: 1, maxLength: 5 },
      },
      required: ['a'],
    }) as Record<string, unknown>;

    for (const key of [
      '$schema',
      '$id',
      'additionalProperties',
      'examples',
      'uniqueItems',
    ]) {
      expect(result).not.toHaveProperty(key);
    }

    // The keywords that carry meaning survive.
    expect(result.required).toEqual(['a']);
    const a = (result.properties as Record<string, Record<string, unknown>>).a!;
    expect(a.pattern).toBe('^a');
    expect(a.minLength).toBe(1);
  });

  it('keeps the shape of a nested object and array', () => {
    const schema = toProviderJsonSchema(
      z.object({
        service: z.string().describe('The service.'),
        labels: z.array(z.string()).optional(),
        nested: z.object({ id: z.string() }).optional(),
      }),
    );

    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.service!.description).toBe('The service.');
    expect(properties.labels!.type).toBe('array');
    expect(properties.labels!.items).toEqual({ type: 'string' });
    expect(properties.nested!.type).toBe('object');
  });

  it('publishes a tool catalogue that no provider can reject', () => {
    const agent = new Agent({
      provider: new NoopProvider(),
      registry: new ToolRegistry().registerAll(createTools()),
      systemPrompt: 'test',
    });

    const catalogue = agent.toolCatalogue();
    expect(catalogue.length).toBeGreaterThan(0);

    for (const tool of catalogue) {
      const serialised = JSON.stringify(tool.parameters);
      expect(tool.parameters).not.toHaveProperty('$schema');
      expect(serialised).not.toContain('exclusiveMinimum');
      expect(serialised).not.toContain('exclusiveMaximum');
      expect(serialised).not.toContain('additionalProperties');
    }
  });
});
