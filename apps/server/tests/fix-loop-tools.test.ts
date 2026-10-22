import { describe, expect, it } from 'vitest';

import { createMockOpsAdapters } from '../src/tools/ops/mock.js';
import { createOpsTools } from '../src/tools/ops/index.js';
import { ToolError, type MucaTool } from '../src/tools/registry.js';

/**
 * The fix loop: reading a review, checking the CI, and pushing the fix.
 *
 * The point of these tests is that the tools **do** something. A
 * `push_commit` that returns a commit and changes nothing would pass a
 * shallow test and fail the demo.
 */

/** The tools, and a way to call them. */
function build() {
  const adapters = createMockOpsAdapters();
  const tools = new Map(
    createOpsTools(adapters).map((tool) => [tool.name, tool]),
  );

  const call = async (name: string, args: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`No tool called ${name}.`);
    const parsed = tool.inputSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(
        `Invalid arguments for ${name}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    return tool.handler(parsed.data);
  };

  return { adapters, tools, call };
}

/** The file the reviewer is unhappy about, in its fixed form. */
const FIXED_CART = `import { priceCart } from './pricing';

export interface Cart {
  id: string;
  customerId: string;
  lines: Array<{ sku: string; quantity: number }>;
}

export function loadCart(session: Session): Cart {
  const customer = session.customer;
  const lines = session.lines;
  return { id: session.id, customerId: customer.id, lines };
}
`;

describe('the pull request tools', () => {
  it('reads the seeded pull request', async () => {
    const { call } = build();

    const result = await call('get_pull_request', { number: 700 });
    const data = result.data as {
      number: number;
      state: string;
      branch: string;
      baseBranch: string;
      author: string;
      url: string;
      files: string[];
      diff: string;
      reviewSummary?: string;
      checksSummary?: string;
    };

    expect(data.number).toBe(700);
    expect(data.state).toBe('open');
    expect(data.branch).toBe('fix/checkout-rounding');
    expect(data.baseBranch).toBe('main');
    expect(data.author).toBe('muca-ops-copilot');
    expect(data.url).toContain('/pull/700');

    // The files it changes, and a real diff.
    expect(data.files).toContain('src/checkout/cart.ts');
    expect(data.files).toContain('src/checkout/pricing.ts');
    expect(data.diff).toContain('--- a/src/checkout/cart.ts');
    expect(data.diff).toContain('+import { loadCustomer }');
    expect(data.diff).toContain('+  const customer = loadCustomer(session.customerId);');

    // The summaries.
    expect(data.reviewSummary).toContain('2 review(s)');
    expect(data.checksSummary).toContain('2 check(s)');
  });

  it('lists the two reviews', async () => {
    const { call } = build();

    const result = await call('list_pull_request_reviews', { number: 700 });
    const data = result.data as {
      count: number;
      reviews: Array<{ reviewer: string; state: string; body: string; createdAt: string }>;
    };

    expect(data.count).toBe(2);
    expect(data.reviews.map((r) => r.reviewer)).toEqual([
      'priya.raman',
      'sam.okafor',
    ]);
    expect(data.reviews[0]?.state).toBe('changes_requested');
    expect(data.reviews[0]?.body).toContain('loads the customer twice');
    expect(data.reviews[1]?.state).toBe('commented');
    expect(data.reviews[0]?.createdAt).toBeTruthy();
  });

  it('lists the three review comments, one of them resolved', async () => {
    const { call } = build();

    const result = await call('list_pull_request_comments', { number: 700 });
    const data = result.data as {
      count: number;
      openCount: number;
      comments: Array<{
        author: string;
        path: string;
        line: number;
        body: string;
        createdAt: string;
        resolved: boolean;
      }>;
    };

    expect(data.count).toBe(3);
    expect(data.openCount).toBe(2);
    expect(data.comments.map((c) => c.path)).toEqual([
      'src/checkout/cart.ts',
      'src/checkout/cart.ts',
      'src/checkout/pricing.ts',
    ]);
    expect(data.comments[0]?.line).toBe(10);
    expect(data.comments[0]?.resolved).toBe(false);
    expect(data.comments[2]?.resolved).toBe(true);
  });

  it('is a clean error for a pull request that does not exist', async () => {
    const { call } = build();

    await expect(call('get_pull_request', { number: 999 })).rejects.toThrow(
      ToolError,
    );
    await expect(
      call('list_pull_request_reviews', { number: 999 }),
    ).rejects.toThrow(/No pull request with number 999/);
    await expect(
      call('list_pull_request_comments', { number: 999 }),
    ).rejects.toThrow(/No pull request with number 999/);
  });

  it('rejects a pull request number that is not a number', async () => {
    const { call } = build();
    await expect(call('get_pull_request', { number: 'seven' })).rejects.toThrow(
      /Invalid arguments/,
    );
  });
});

describe('the CI and commit tools', () => {
  it('lists the workflow runs of a branch', async () => {
    const { call } = build();

    const result = await call('list_workflow_runs', {
      branch: 'fix/checkout-rounding',
    });
    const data = result.data as {
      count: number;
      runs: Array<{
        runId: string;
        name: string;
        status: string;
        failedJob?: string;
        failedStep?: string;
        logExcerpt?: string[];
      }>;
    };

    expect(data.count).toBe(2);
    expect(data.runs.map((r) => r.status)).toContain('failure');
    expect(data.runs.map((r) => r.status)).toContain('success');

    const failure = data.runs.find((r) => r.status === 'failure')!;
    expect(failure.failedJob).toBe('test');
    expect(failure.failedStep).toBe('unit-tests');
    expect(failure.logExcerpt?.length).toBeGreaterThan(0);
  });

  it('lists the commits of a branch, with the deployment they produced', async () => {
    const { call } = build();

    const result = await call('list_commits', { branch: 'fix/checkout-rounding' });
    const data = result.data as {
      count: number;
      commits: Array<{
        sha: string;
        message: string;
        author: string;
        createdAt: string;
        files: string[];
        deploymentId?: string;
      }>;
    };

    expect(data.count).toBe(2);
    expect(data.commits[0]?.files).toEqual(['src/checkout/cart.ts']);
    expect(data.commits[0]?.message).toContain('read the customer');

    // A commit on main that produced a deployment.
    const main = await call('list_commits', { branch: 'main' });
    const mainData = main.data as {
      commits: Array<{ sha: string; deploymentId?: string }>;
    };
    expect(mainData.commits.some((c) => c.deploymentId)).toBe(true);
  });

  it('filters the commits by service', async () => {
    const { adapters, call } = build();

    // The service of a deployment that a commit produced.
    const deployment = adapters.deployments
      .list('', 20)
      .find((d) => d.commit === 'd47b0aa');
    expect(deployment).toBeDefined();

    const result = await call('list_commits', {
      service: deployment!.service,
      limit: 10,
    });
    const data = result.data as {
      count: number;
      commits: Array<{ deploymentId?: string }>;
    };
    expect(data.count).toBeGreaterThan(0);
    expect(data.commits.every((c) => c.deploymentId)).toBe(true);
  });
});

describe('push_commit', () => {
  it('really changes the branch', async () => {
    const { adapters, call } = build();

    const before = await call('get_pull_request', { number: 700 });
    const beforeData = before.data as { files: string[]; diff: string };
    const beforeCommits = await call('list_commits', {
      branch: 'fix/checkout-rounding',
    });
    const beforeCount = (beforeCommits.data as { count: number }).count;
    const beforeRuns = await call('list_workflow_runs', {
      branch: 'fix/checkout-rounding',
    });
    const beforeRunData = beforeRuns.data as {
      runs: Array<{ runId: string; status: string }>;
    };
    // The value, not the object: the adapter mutates the runs in place.
    const beforeStatus = beforeRunData.runs.find(
      (r) => r.runId === 'run_4901',
    )?.status;

    expect(beforeData.files).toContain('src/checkout/cart.ts');
    expect(beforeData.diff).toContain('loadCustomer');

    // The push.
    const pushed = await call('push_commit', {
      branch: 'fix/checkout-rounding',
      path: 'src/checkout/cart.ts',
      content: FIXED_CART,
      message: 'fix(cart): use the customer already on the session',
      number: 700,
    });

    const pushedData = pushed.data as {
      commit: { sha: string; message: string; files: string[] };
      files: string[];
      diff: string;
    };

    expect(pushedData.commit.message).toBe(
      'fix(cart): use the customer already on the session',
    );
    expect(pushedData.commit.files).toEqual(['src/checkout/cart.ts']);
    expect(pushedData.commit.sha).toMatch(/^[0-9a-f]{7}$/);

    // The pull request sees the new diff, and the file list changed.
    const after = await call('get_pull_request', { number: 700 });
    const afterData = after.data as { files: string[]; diff: string };

    expect(afterData.diff).not.toBe(beforeData.diff);
    expect(afterData.diff).not.toContain('loadCustomer');
    expect(afterData.files).not.toContain('src/checkout/cart.ts');
    expect(afterData.files).toContain('src/checkout/pricing.ts');
    expect(pushedData.files).toEqual(afterData.files);
    expect(pushedData.diff).toBe(afterData.diff);

    // The commit list grew.
    const afterCommits = await call('list_commits', {
      branch: 'fix/checkout-rounding',
    });
    const afterCount = (afterCommits.data as { count: number }).count;
    expect(afterCount).toBe(beforeCount + 1);

    // The CI runs are queued again.
    const afterRuns = await call('list_workflow_runs', {
      branch: 'fix/checkout-rounding',
    });
    const afterRunData = afterRuns.data as {
      runs: Array<{ runId: string; status: string; failedJob?: string }>;
    };
    expect(
      afterRunData.runs.every((run) => run.status === 'queued'),
    ).toBe(true);
    expect(afterRunData.runs.find((r) => r.runId === 'run_4901')?.failedJob).toBe(
      undefined,
    );
    expect(beforeStatus).toBe('failure');

    // And the branch's head moved.
    const branch = adapters.git
      .listBranches()
      .find((b) => b.name === 'fix/checkout-rounding');
    expect(branch?.headCommit).toBe(pushedData.commit.sha);
  });

  it('is deterministic', async () => {
    const first = await build().call('push_commit', {
      branch: 'fix/checkout-rounding',
      path: 'src/checkout/cart.ts',
      content: FIXED_CART,
      message: 'fix(cart): use the customer already on the session',
    });
    const second = await build().call('push_commit', {
      branch: 'fix/checkout-rounding',
      path: 'src/checkout/cart.ts',
      content: FIXED_CART,
      message: 'fix(cart): use the customer already on the session',
    });

    expect((first.data as { commit: { sha: string } }).commit.sha).toBe(
      (second.data as { commit: { sha: string } }).commit.sha,
    );
  });

  it('rejects a commit with no message', async () => {
    const { call } = build();
    await expect(
      call('push_commit', {
        branch: 'fix/checkout-rounding',
        path: 'src/checkout/cart.ts',
        content: FIXED_CART,
        message: '',
      }),
    ).rejects.toThrow(/Invalid arguments/);
  });
});

describe('reply_to_review', () => {
  it('replies to a review and resolves the comment', async () => {
    const { call } = build();

    const reply = await call('reply_to_review', {
      number: 700,
      commentId: 'rc_700_1',
      body: 'Good catch — the customer is already on the session. Fixed in the new commit.',
    });

    const data = reply.data as {
      id: string;
      number: number;
      commentId: string;
      reviewId?: string;
      body: string;
      createdAt: string;
    };

    expect(data.number).toBe(700);
    expect(data.commentId).toBe('rc_700_1');
    expect(data.reviewId).toBe('rev_700_1');
    expect(data.body).toContain('Good catch');
    expect(data.createdAt).toBeTruthy();

    // The comment is resolved now.
    const comments = await call('list_pull_request_comments', { number: 700 });
    const commentData = comments.data as {
      comments: Array<{ id: string; resolved: boolean }>;
    };
    expect(
      commentData.comments.find((c) => c.id === 'rc_700_1')?.resolved,
    ).toBe(true);
    expect(
      commentData.comments.find((c) => c.id === 'rc_700_2')?.resolved,
    ).toBe(false);
  });

  it('replies to a review', async () => {
    const { call } = build();

    const reply = await call('reply_to_review', {
      number: 700,
      reviewId: 'rev_700_1',
      body: 'Pushed the change: the customer now comes from the session.',
    });

    const data = reply.data as { reviewId?: string; commentId?: string };
    expect(data.reviewId).toBe('rev_700_1');
    expect(data.commentId).toBeUndefined();
  });

  it('is a clean error for a comment that does not exist', async () => {
    const { call } = build();
    await expect(
      call('reply_to_review', {
        number: 700,
        commentId: 'rc_nope',
        body: 'hello',
      }),
    ).rejects.toThrow(/No review comment with id rc_nope/);
  });

  it('is a clean error for a pull request that does not exist', async () => {
    const { call } = build();
    await expect(
      call('reply_to_review', { number: 999, body: 'hello' }),
    ).rejects.toThrow(/No pull request with number 999/);
  });
});

describe('the new tools in the registry', () => {
  it('registers the seven of them with the right annotations', () => {
    const tools = createOpsTools(createMockOpsAdapters());
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const reads = [
      'get_pull_request',
      'list_pull_request_reviews',
      'list_pull_request_comments',
      'list_workflow_runs',
      'list_commits',
    ];
    const writes = ['push_commit', 'reply_to_review'];

    for (const name of reads) {
      const tool = byName.get(name) as MucaTool | undefined;
      expect(tool, `${name} is missing`).toBeDefined();
      expect(tool!.writes, `${name} should not write`).toBe(false);
      expect(tool!.destructive, `${name} should not be destructive`).toBe(false);
    }

    for (const name of writes) {
      const tool = byName.get(name) as MucaTool | undefined;
      expect(tool, `${name} is missing`).toBeDefined();
      expect(tool!.writes, `${name} should write`).toBe(true);
      // A write is not automatically a consequential act: the policy
      // engine decides, and the MCP path is unchanged.
      expect(tool!.destructive, `${name} should not be destructive`).toBe(false);
    }
  });
});
