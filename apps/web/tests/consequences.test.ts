import { describe, expect, it } from 'vitest';

import {
  describeConsequence,
  describeRemembering,
} from '../lib/consequences';

/**
 * The plain-English consequence.
 *
 * The permission card has to say what will change before it happens, in
 * words a person can act on.
 */

describe('describeConsequence', () => {
  it('says what a branch will do, in a sentence', () => {
    const sentence = describeConsequence(
      { name: 'create_branch' },
      { name: 'fix/checkout', baseBranch: 'main' },
    );

    expect(sentence).toContain('fix/checkout');
    expect(sentence).toContain('main');
    expect(sentence).toMatch(/branch/i);
  });

  it('says what a pull request will do', () => {
    const sentence = describeConsequence(
      { name: 'open_pull_request' },
      { branch: 'fix/x', baseBranch: 'main' },
    );

    expect(sentence).toMatch(/pull request/i);
    expect(sentence).toContain('fix/x');
  });

  it('falls back to the tool description for a tool it does not know', () => {
    const sentence = describeConsequence(
      {
        name: 'mystery_tool',
        description: 'Does a thing to the deployment.',
      },
      {},
    );

    expect(sentence).toContain('Does a thing to the deployment.');
  });

  it('never returns nothing', () => {
    expect(describeConsequence(undefined, {}).length).toBeGreaterThan(0);
  });
});

describe('describeRemembering', () => {
  it('says what will be remembered, in words', () => {
    const sentence = describeRemembering(
      { name: 'create_branch' },
      { name: 'fix/checkout', baseBranch: 'main' },
    );

    expect(sentence).toContain('create_branch');
    expect(sentence).toMatch(/remember/i);
  });
});
