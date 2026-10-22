import { describe, expect, it } from 'vitest';

import { buildArtifact } from '../lib/artifacts';

/**
 * The cards of the fix loop.
 *
 * The two moments the story turns on are a review that asked for a change
 * and a CI run that failed, so those two have to be legible at a glance:
 * a labelled badge, the job, the step, the log.
 */

function card(toolName: string, data: unknown) {
  return buildArtifact({ id: 'a1', toolName, data });
}

const DIFF = `diff --git a/src/payments/charge.js b/src/payments/charge.js
--- a/src/payments/charge.js
+++ b/src/payments/charge.js
@@ -38,6 +38,7 @@ export async function chargeCard(order) {
   const customer = await loadCustomer(order.customerId);
-  const id = order.customer.id;
+  const id = customer.id;`;

describe('the pull request card', () => {
  it('shows the pull request with its files, state and author', () => {
    const artifact = card('get_pull_request', {
      number: 212,
      title: 'fix: load the customer before charging',
      body: 'The checkout route reads customer.id before the customer is loaded.',
      branch: 'fix/checkout-missing-customer',
      baseBranch: 'main',
      author: 'muca',
      url: 'https://github.com/acme/checkout-api/pull/212',
      state: 'open',
      files: ['src/payments/charge.js', 'test/unit/charge.test.js'],
      diff: DIFF,
      reviewSummary: '1 review asked for changes',
      checksSummary: 'CI is red',
    });

    expect(artifact?.kind).toBe('pull-request-detail');
    expect(artifact?.title).toBe('PR #212 · fix: load the customer before charging');
    expect(artifact?.subtitle).toBe('fix/checkout-missing-customer → main');
    expect(artifact?.status).toBe('success');

    const labels = artifact?.fields.map((field) => field.label);
    expect(labels).toContain('State');
    expect(labels).toContain('Author');
    expect(labels).toContain('Reviews');
    expect(labels).toContain('Checks');

    expect(artifact?.lines).toEqual([
      'src/payments/charge.js',
      'test/unit/charge.test.js',
    ]);
    expect(artifact?.code).toBe(DIFF);
  });

  it('reads the base branch under either name', () => {
    const artifact = card('get_pull_request', {
      number: 7,
      title: 'a change',
      branch: 'feature/x',
      base: 'main',
      state: 'open',
    });

    expect(artifact?.subtitle).toBe('feature/x → main');
  });
});

describe('the pushed commit card', () => {
  it('shows the commit, the file and the diff it produced', () => {
    // The shape the server returns: the commit, the pull request it
    // belongs to, the files it changed and the updated diff.
    const artifact = card('push_commit', {
      commit: {
        sha: 'a1c4f7e',
        message: 'fix: load the customer once, from the session',
        author: 'muca',
        createdAt: '2026-10-22T09:51:03.000Z',
        files: ['src/payments/charge.js'],
      },
      pullRequest: { number: 700, title: 'Fix the checkout total rounding' },
      files: ['src/payments/charge.js', 'test/unit/charge.test.js'],
      diff: DIFF,
    });

    expect(artifact?.kind).toBe('commit-pushed');
    expect(artifact?.title).toBe('Pushed a1c4f7e');
    expect(artifact?.subtitle).toBe('fix: load the customer once, from the session');
    expect(artifact?.status).toBe('success');
    expect(artifact?.code).toBe(DIFF);
    expect(artifact?.lines).toEqual([
      'src/payments/charge.js',
      'test/unit/charge.test.js',
    ]);

    const file = artifact?.fields.find((field) => field.label === 'File');
    expect(file?.value).toBe('src/payments/charge.js');
    const pullRequest = artifact?.fields.find(
      (field) => field.label === 'Pull request',
    );
    expect(pullRequest?.value).toBe('#700');
  });

  it('still reads a flat result', () => {
    const artifact = card('push_commit', {
      sha: 'b19d7e2',
      message: 'fix: load the customer once',
      path: 'src/payments/charge.js',
      diff: DIFF,
    });

    expect(artifact?.title).toBe('Pushed b19d7e2');
    expect(artifact?.code).toBe(DIFF);
  });
});

describe('the review cards', () => {
  it('shows one row per review, with a labelled state badge', () => {
    const artifact = card('list_pull_request_reviews', {
      reviews: [
        {
          reviewer: 'r.alvarez',
          state: 'changes_requested',
          body: 'This loads the customer twice — it is already on the session.',
          when: '2026-10-22T09:20:00.000Z',
        },
        {
          reviewer: 'k.park',
          state: 'approved',
          body: 'Looks right to me.',
          when: '2026-10-22T09:31:00.000Z',
        },
        {
          reviewer: 's.oyelaran',
          state: 'commented',
          body: 'One nit about the naming.',
          when: '2026-10-22T09:40:00.000Z',
        },
      ],
    });

    expect(artifact?.kind).toBe('review-list');
    expect(artifact?.title).toBe('Reviews');
    expect(artifact?.status).toBe('failed');
    expect(artifact?.rows).toHaveLength(3);

    expect(artifact?.rows?.[0]).toMatchObject({
      title: 'r.alvarez',
      badge: { label: 'changes requested', tone: 'failed' },
    });
    expect(artifact?.rows?.[0].body).toContain('loads the customer twice');

    expect(artifact?.rows?.[1]).toMatchObject({
      title: 'k.park',
      badge: { label: 'approved', tone: 'success' },
    });
    expect(artifact?.rows?.[2]).toMatchObject({
      badge: { label: 'commented', tone: 'neutral' },
    });
  });

  it('is healthy when every review approved', () => {
    const artifact = card('list_pull_request_reviews', {
      reviews: [{ reviewer: 'k.park', state: 'approved', body: 'ok' }],
    });

    expect(artifact?.status).toBe('success');
    expect(artifact?.subtitle).toBe('1 review');
  });

  it('shows one row per comment, with the file, the line and the state', () => {
    const artifact = card('list_pull_request_comments', {
      comments: [
        {
          author: 'r.alvarez',
          path: 'src/payments/charge.js',
          line: 41,
          body: 'This reads customer.id before the customer is loaded.',
          when: '2026-10-22T09:20:00.000Z',
          resolved: false,
        },
        {
          author: 'k.park',
          file: 'test/unit/charge.test.js',
          line: 12,
          body: 'Add a regression test.',
          resolved: true,
        },
      ],
    });

    expect(artifact?.kind).toBe('review-comment-list');
    expect(artifact?.rows).toHaveLength(2);

    expect(artifact?.rows?.[0]).toMatchObject({
      title: 'r.alvarez',
      meta: 'src/payments/charge.js:41',
      badge: { label: 'open', tone: 'warn' },
    });
    expect(artifact?.rows?.[1]).toMatchObject({
      title: 'k.park',
      meta: 'test/unit/charge.test.js:12',
      badge: { label: 'resolved', tone: 'success' },
    });
  });

  it('shows the reply and that the comment is resolved', () => {
    // The shape the server returns: the reply itself.
    const artifact = card('reply_to_review', {
      id: 'rep_1',
      number: 700,
      commentId: 'rc_700_1',
      author: 'muca',
      body: 'You are right: the customer is already on the session. I load it once now and added a regression test.',
      createdAt: '2026-10-22T09:52:00.000Z',
    });

    expect(artifact?.kind).toBe('review-reply');
    expect(artifact?.status).toBe('success');
    expect(artifact?.body).toContain('already on the session');
    expect(artifact?.rows?.[0]).toMatchObject({
      badge: { label: 'resolved', tone: 'success' },
    });

    const answered = artifact?.fields.find(
      (field) => field.label === 'Answered',
    );
    expect(answered?.value).toBe('rc_700_1');
  });

  it('reads a nested reply as well', () => {
    const artifact = card('reply_to_review', {
      reply: {
        reviewId: 'rev_700_1',
        body: 'Fixed.',
        when: '2026-10-22T09:52:00.000Z',
      },
      resolved: true,
    });

    expect(artifact?.body).toBe('Fixed.');
    expect(artifact?.rows?.[0]).toMatchObject({
      badge: { label: 'resolved', tone: 'success' },
    });
  });
});

describe('the CI run card', () => {
  it('shows one row per run, with the failure when it failed', () => {
    const artifact = card('list_workflow_runs', {
      runs: [
        {
          runId: 'wf_9911',
          name: 'ci / integration',
          branch: 'fix/checkout-missing-customer',
          status: 'failure',
          conclusion: 'failure',
          failedJob: 'test/integration',
          failedStep: 'checkout',
          error: 'TypeError: Cannot read properties of undefined',
          logExcerpt: ['✗ integration/checkout', '  at chargeCard (charge.js:41)'],
        },
        {
          runId: 'wf_9910',
          name: 'ci / unit',
          branch: 'main',
          status: 'success',
          conclusion: 'success',
        },
        {
          runId: 'wf_9912',
          name: 'ci / lint',
          branch: 'main',
          status: 'running',
        },
      ],
    });

    expect(artifact?.kind).toBe('workflow-run-list');
    expect(artifact?.title).toBe('CI runs');
    expect(artifact?.status).toBe('failed');
    expect(artifact?.rows).toHaveLength(3);

    expect(artifact?.rows?.[0]).toMatchObject({
      title: 'ci / integration',
      badge: { label: 'failure', tone: 'failed' },
    });
    expect(artifact?.rows?.[0].fields).toEqual([
      { label: 'Failed job', value: 'test/integration', mono: true },
      { label: 'Failed step', value: 'checkout', mono: true },
    ]);
    expect(artifact?.rows?.[0].code).toContain('chargeCard');

    expect(artifact?.rows?.[1]).toMatchObject({
      badge: { label: 'success', tone: 'success' },
    });
    // A run that did not fail has no failed job and no failed step.
    expect(artifact?.rows?.[1].fields).toBeUndefined();
    expect(artifact?.rows?.[2]).toMatchObject({
      badge: { label: 'running', tone: 'warn' },
    });
  });

  it('marks a queued run as waiting', () => {
    const artifact = card('list_workflow_runs', {
      runs: [{ runId: 'wf_1', name: 'ci / build', status: 'queued' }],
    });

    expect(artifact?.rows?.[0]).toMatchObject({
      badge: { label: 'queued', tone: 'warn' },
    });
  });
});

describe('the commit list card', () => {
  it('shows a compact row per commit', () => {
    const artifact = card('list_commits', {
      commits: [
        {
          sha: 'a1c4f7e',
          message: 'fix: load the customer before charging',
          author: 'r.alvarez',
          createdAt: '2026-10-22T09:12:00.000Z',
          files: ['src/payments/charge.js'],
        },
        {
          sha: '9b02d11',
          message: 'chore: bump the checkout dependency',
          author: 'k.park',
          createdAt: '2026-10-21T16:02:00.000Z',
          files: ['package.json', 'package-lock.json'],
        },
      ],
    });

    expect(artifact?.kind).toBe('commit-list');
    expect(artifact?.title).toBe('Commits');
    expect(artifact?.subtitle).toBe('2 commits');
    expect(artifact?.rows).toHaveLength(2);

    expect(artifact?.rows?.[0]).toMatchObject({
      title: 'fix: load the customer before charging',
      meta: 'a1c4f7e · r.alvarez · 2026-10-22T09:12:00.000Z',
    });
    expect(artifact?.rows?.[0].lines).toEqual(['src/payments/charge.js']);
  });

  it('shows the deployment a commit produced', () => {
    const artifact = card('list_commits', {
      commits: [
        {
          sha: 'a1c4f7e',
          message: 'fix: load the customer before charging',
          author: 'r.alvarez',
          createdAt: '2026-10-22T09:12:00.000Z',
          files: ['src/payments/charge.js'],
          deploymentId: 'dpl_8f21',
        },
      ],
    });

    expect(artifact?.rows?.[0].fields).toEqual([
      { label: 'Deployment', value: 'dpl_8f21', mono: true },
    ]);
  });
});

describe('the generic fallback', () => {
  it('still renders a card for a tool it does not know', () => {
    const artifact = card('some_new_tool', {
      thing: 'a value',
      count: 3,
    });

    expect(artifact).not.toBeNull();
    expect(artifact?.kind).toBe('object');
  });

  it('returns nothing for a payload with nothing in it', () => {
    expect(card('some_new_tool', 'not an object')).toBeNull();
  });
});
