import { describe, expect, it } from 'vitest';

import {
  compactMessages,
  estimateTokens,
  extractIdentifiers,
  shouldCompact,
  summaryBlock,
} from '../src/ai/compaction.js';
import {
  ContextLimitResolver,
  DEFAULT_INPUT_LIMIT,
  limitFromTable,
  parseBudgetTag,
} from '../src/ai/context-limits.js';
import type { ProviderMessage } from '../src/ai/provider.js';

/**
 * Compaction and the context limit.
 *
 * The point of both: a long session stays cheap, and it never exceeds
 * the model's input limit. The thing that must never be lost is the
 * **identifiers**: a deployment id is the thread the whole trail hangs
 * on.
 */
describe('the compaction', () => {
  it('estimates the tokens of a conversation', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'a'.repeat(400) },
    ];
    expect(estimateTokens(messages)).toBe(100);
  });

  it('triggers at the fraction of the limit', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'a'.repeat(4000) },
    ];

    // 1000 tokens against a limit of 1000: the threshold is 0.8.
    expect(
      shouldCompact(messages, { inputLimit: 1000, threshold: 0.8 }),
    ).toBe(true);
    expect(
      shouldCompact(messages, { inputLimit: 10_000, threshold: 0.8 }),
    ).toBe(false);
  });

  it('prefers the counted tokens over the estimate', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'short' },
    ];

    expect(
      shouldCompact(messages, {
        inputLimit: 1000,
        threshold: 0.8,
        countedTokens: 900,
      }),
    ).toBe(true);
  });

  it('finds the identifiers a conversation has seen', () => {
    const messages: ProviderMessage[] = [
      {
        role: 'assistant',
        content: 'The CI run run_4807 failed for dep_abc_1.',
        toolCalls: [
          {
            id: 'c1',
            name: 'comment_on_issue',
            arguments: JSON.stringify({ issueNumber: 12, body: 'see issue #7' }),
          },
        ],
      },
    ];

    const ids = extractIdentifiers(messages);
    expect(ids.deployments).toContain('dep_abc_1');
    expect(ids.runs).toContain('run_4807');
    expect(ids.issues).toContain(12);
    expect(ids.issues).toContain(7);
  });

  it('keeps the last three turns, the tool pairs and the identifiers', () => {
    const messages: ProviderMessage[] = [
      { role: 'system', content: 'You are Muca.' },
      { role: 'user', content: 'turn one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: 'turn two' },
      { role: 'assistant', content: 'answer two' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'call_1',
            name: 'get_deployment',
            arguments: JSON.stringify({ deploymentId: 'dep_keep_1' }),
          },
        ],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        name: 'get_deployment',
        content: 'Deployment dep_keep_1 is broken. CI run run_keep_1 failed.',
      },
      { role: 'user', content: 'turn three' },
      { role: 'assistant', content: 'answer three' },
      { role: 'user', content: 'turn four' },
      { role: 'assistant', content: 'answer four' },
    ];

    const compacted = compactMessages(messages, {
      inputLimit: 1000,
      summary: 'The deployment dep_keep_1 is broken.',
      keepTurns: 3,
    });

    // The system prompt stays first.
    expect(compacted[0]?.role).toBe('system');

    // The summary follows it.
    expect(compacted[1]?.role).toBe('user');
    expect(compacted[1]?.content).toContain('The deployment dep_keep_1 is broken.');

    // The identifiers survive, even though the summary is shorter than
    // the conversation.
    const summary = compacted[1]?.content ?? '';
    expect(summary).toContain('dep_keep_1');
    expect(summary).toContain('run_keep_1');

    // The tool call and its result are kept.
    const toolCall = compacted.find(
      (message) => message.role === 'assistant' && message.toolCalls?.length,
    );
    expect(toolCall).toBeDefined();
    expect(
      compacted.some((message) => message.role === 'tool'),
    ).toBe(true);

    // The last three turns are kept verbatim.
    const contents = compacted.map((message) => message.content);
    expect(contents).toContain('turn two');
    expect(contents).toContain('turn three');
    expect(contents).toContain('turn four');
    expect(contents).toContain('answer four');
  });

  it('never reorders the messages it keeps', () => {
    const messages: ProviderMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ];

    const compacted = compactMessages(messages, {
      inputLimit: 1000,
      summary: 's',
      keepTurns: 1,
    });

    const kept = compacted.slice(2).map((message) => message.content);
    expect(kept).toEqual(['three']);
  });

  it('says what it kept in the summary block', () => {
    const block = summaryBlock('The summary.', {
      deployments: ['dep_1'],
      runs: ['run_1'],
      issues: [3],
    });

    expect(block).toContain('deployment dep_1');
    expect(block).toContain('CI run run_1');
    expect(block).toContain('issue #3');
  });
});

describe('the context limit', () => {
  it('reads the table for the known models', () => {
    expect(limitFromTable('anthropic', 'claude-sonnet-4-5-20250929')).toEqual({
      limit: 200_000,
      matched: true,
      label: expect.any(String),
    });
    expect(limitFromTable('gemini', 'gemini-2.5-flash').limit).toBe(1_048_576);
    expect(limitFromTable('openai', 'gpt-4o-mini').limit).toBe(128_000);
    expect(limitFromTable('openai', 'gpt-4').limit).toBe(8_192);
  });

  it('falls back to 128,000 for a model the table does not name', () => {
    const fallback = limitFromTable('anthropic', 'claude-unknown-9');
    expect(fallback.limit).toBe(DEFAULT_INPUT_LIMIT);
    expect(fallback.matched).toBe(false);
  });

  it('reads the budget tag out of an Anthropic reply', () => {
    expect(
      parseBudgetTag('<budget:token_budget>200000</budget:token_budget>'),
    ).toBe(200_000);
    expect(parseBudgetTag('nothing here')).toBeNull();
  });

  it('falls back to the table when the provider cannot be asked', async () => {
    const resolver = new ContextLimitResolver(async () => {
      throw new Error('the network is down');
    });

    const limit = await resolver.resolve({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      endpoint: 'https://anthropic.test',
      apiKey: 'k',
    });

    expect(limit.inputTokens).toBe(200_000);
    expect(limit.source).toBe('table');
  });

  it('uses the counting endpoint when the provider has one', async () => {
    const requests: string[] = [];
    const resolver = new ContextLimitResolver(async (url) => {
      requests.push(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ input_tokens: 1234 }),
        text: async () => '',
      };
    });

    const limit = await resolver.resolve({
      provider: 'anthropic',
      model: 'claude-x',
      endpoint: 'https://anthropic.test',
      apiKey: 'k',
    });

    expect(limit.inputTokens).toBe(1234);
    expect(limit.source).toBe('counted');
    expect(requests[0]).toContain('/v1/messages/count_tokens');
  });

  it('reads the published limit from the models endpoint', async () => {
    const resolver = new ContextLimitResolver(async (url) => {
      if (url.includes('countTokens')) {
        return { ok: false, status: 400, json: async () => ({}), text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          models: [{ name: 'models/gemini-2.5-flash', inputTokenLimit: 1_048_576 }],
        }),
        text: async () => '',
      };
    });

    const limit = await resolver.resolve({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      endpoint: 'https://gemini.test/v1beta',
      apiKey: 'k',
    });

    expect(limit.inputTokens).toBe(1_048_576);
    expect(limit.source).toBe('models');
  });

  it('never blocks on a limit that cannot be established', async () => {
    const resolver = new ContextLimitResolver(
      async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => '',
      }),
    );

    const limit = await resolver.resolve({
      provider: 'openai',
      model: 'gpt-4o',
      endpoint: 'https://openai.test/v1',
      apiKey: 'k',
    });

    expect(limit.inputTokens).toBe(128_000);
  });
});
