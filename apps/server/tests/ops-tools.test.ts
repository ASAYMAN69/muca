import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { createOpsTools, createDiagnosis } from '../src/tools/ops/index.js';
import { createMockOpsAdapters, MOCK_SERVICES } from '../src/tools/ops/mock.js';
import { ToolError } from '../src/tools/registry.js';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One registry for the whole file.
 *
 * The mock adapters are stateful (a created issue stays created), so the
 * tests share a single registry the way a real session would.
 */
const sharedRegistry = new ToolRegistry().registerAll(createTools());

function registry() {
  return sharedRegistry;
}

async function call(name: string, args: Record<string, unknown>) {
  const tool = sharedRegistry.get(name);
  if (!tool) throw new Error(`No tool named ${name}`);
  return tool.handler(args);
}

async function callExpectingError(name: string, args: Record<string, unknown>) {
  try {
    await call(name, args);
  } catch (error) {
    return error;
  }
  throw new Error(`Expected ${name} to throw.`);
}

/* -------------------------------------------------------------------------- */
/* The tool set                                                               */
/* -------------------------------------------------------------------------- */

describe('The Ops Copilot tool set', () => {
  it('publishes the whole domain', () => {
    const names = registry().list().map((t) => t.name);

    expect(names).toContain('list_deployments');
    expect(names).toContain('get_deployment');
    expect(names).toContain('get_ci_failure');
    expect(names).toContain('list_issues');
    expect(names).toContain('create_issue');
    expect(names).toContain('comment_on_issue');
    expect(names).toContain('create_branch');
    expect(names).toContain('open_pull_request');
  });

  it('marks only the consequential tools as destructive', () => {
    const tools = registry().list();

    const destructive = tools
      .filter((t) => t.destructive)
      .map((t) => t.name)
      .sort();

    expect(destructive).toEqual(['create_branch', 'open_pull_request']);
  });

  it('removes the placeholder note tools', () => {
    const names = registry().list().map((t) => t.name);
    expect(names).not.toContain('create_note');
    expect(names).not.toContain('list_notes');
    expect(names).not.toContain('get_note');
    expect(names).not.toContain('delete_note');
    expect(names).not.toContain('clear_notes');
    expect(names).not.toContain('get_weather');
  });

  it('keeps echo as a connectivity check', () => {
    const echo = registry().get('echo');
    expect(echo).toBeDefined();
    expect(echo?.destructive).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* list_deployments                                                           */
/* -------------------------------------------------------------------------- */

describe('list_deployments', () => {
  it('lists deployments with their status', async () => {
    const result = await call('list_deployments', { limit: 5 });

    expect(result.summary).toContain('deployment(s)');
    const data = result.data as { count: number; deployments: Array<{ id: string; status: string }> };
    expect(data.count).toBeGreaterThan(0);
    expect(data.deployments[0]?.id).toBeTruthy();
    expect(data.deployments[0]?.status).toBeTruthy();
  });

  it('filters by service', async () => {
    const result = await call('list_deployments', {
      service: MOCK_SERVICES[0],
      limit: 10,
    });

    const data = result.data as { deployments: Array<{ service: string }> };
    for (const deployment of data.deployments) {
      expect(deployment.service).toBe(MOCK_SERVICES[0]);
    }
  });

  it('is deterministic: the same call returns the same data', async () => {
    const first = await call('list_deployments', { limit: 5 });
    const second = await call('list_deployments', { limit: 5 });

    expect(JSON.stringify(first.data)).toBe(JSON.stringify(second.data));
  });

  it('rejects an invalid limit at the registry boundary', () => {
    const tool = registry().get('list_deployments');
    // The registry validates the arguments before the handler runs.
    expect(tool!.inputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(tool!.inputSchema.safeParse({ limit: 500 }).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* get_deployment                                                             */
/* -------------------------------------------------------------------------- */

describe('get_deployment', () => {
  it('returns one deployment with its log tail', async () => {
    const list = await call('list_deployments', { limit: 1 });
    const { deployments } = list.data as { deployments: Array<{ id: string }> };
    const id = deployments[0]!.id;

    const result = await call('get_deployment', { deploymentId: id });

    expect(result.summary).toContain(id);
    const data = result.data as { logTail: string[] };
    expect(Array.isArray(data.logTail)).toBe(true);
  });

  it('fails with a tool error for an unknown id', async () => {
    const error = await callExpectingError('get_deployment', {
      deploymentId: 'dep_does_not_exist',
    });
    expect(error).toBeInstanceOf(ToolError);
    expect((error as Error).message).toContain('No deployment with id');
  });

  it('rejects a missing id at the registry boundary', () => {
    const tool = registry().get('get_deployment');
    expect(tool!.inputSchema.safeParse({}).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* get_ci_failure                                                             */
/* -------------------------------------------------------------------------- */

describe('get_ci_failure', () => {
  it('returns the failing job, step and error', async () => {
    const list = await call('list_deployments', { limit: 1 });
    const { deployments } = list.data as {
      deployments: Array<{ ciRunId: string | null }>;
    };
    const runId = deployments[0]!.ciRunId;
    expect(runId).toBeTruthy();

    const result = await call('get_ci_failure', { runId: runId! });

    expect(result.summary).toContain('failed at');
    const data = result.data as {
      failedJob: string;
      failedStep: string;
      error: string;
      logExcerpt: string[];
    };
    expect(data.failedJob).toBeTruthy();
    expect(data.failedStep).toBeTruthy();
    expect(data.error).toBeTruthy();
    expect(data.logExcerpt.length).toBeGreaterThan(0);
  });

  it('fails with a tool error for an unknown run', async () => {
    const error = await callExpectingError('get_ci_failure', { runId: 'run_nope' });
    expect(error).toBeInstanceOf(ToolError);
  });
});

/* -------------------------------------------------------------------------- */
/* list_issues / create_issue / comment_on_issue                              */
/* -------------------------------------------------------------------------- */

describe('the issue tools', () => {
  it('lists open issues', async () => {
    const result = await call('list_issues', { state: 'open', limit: 10 });

    const data = result.data as { issues: Array<{ state: string }> };
    expect(data.issues.length).toBeGreaterThan(0);
    for (const issue of data.issues) {
      expect(issue.state).toBe('open');
    }
  });

  it('filters by state', async () => {
    const result = await call('list_issues', { state: 'closed', limit: 10 });

    const data = result.data as { issues: Array<{ state: string }> };
    for (const issue of data.issues) {
      expect(issue.state).toBe('closed');
    }
  });

  it('creates an issue and it shows up in the list', async () => {
    const created = await call('create_issue', {
      title: 'Checkout rounds up',
      body: 'The total is off by one cent.',
      labels: ['bug'],
    });

    const issue = created.data as { number: number; title: string; state: string };
    expect(issue.state).toBe('open');
    expect(issue.title).toBe('Checkout rounds up');

    const list = await call('list_issues', { state: 'open', limit: 50 });
    const { issues } = list.data as { issues: Array<{ number: number }> };
    expect(issues.some((i) => i.number === issue.number)).toBe(true);
  });

  it('adds a comment to an issue', async () => {
    const created = await call('create_issue', {
      title: 'Needs a comment',
      body: '',
      labels: [],
    });
    const issue = created.data as { number: number };

    const result = await call('comment_on_issue', {
      issueNumber: issue.number,
      body: 'The diagnosis says the readiness probe is too shallow.',
    });

    const updated = result.data as { comments: Array<{ body: string }> };
    expect(updated.comments).toHaveLength(1);
    expect(updated.comments[0]?.body).toContain('readiness probe');
  });

  it('fails with a tool error when the issue does not exist', async () => {
    const error = await callExpectingError('comment_on_issue', {
      issueNumber: 9999,
      body: 'hello',
    });
    expect(error).toBeInstanceOf(ToolError);
  });

  it('rejects an empty title at the registry boundary', () => {
    const tool = registry().get('create_issue');
    expect(tool!.inputSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects an empty comment at the registry boundary', () => {
    const tool = registry().get('comment_on_issue');
    expect(tool!.inputSchema.safeParse({ issueNumber: 1, body: '' }).success).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* create_branch / open_pull_request                                          */
/* -------------------------------------------------------------------------- */

describe('the git tools', () => {
  it('creates a branch', async () => {
    const result = await call('create_branch', {
      name: 'fix/checkout-rounding',
      baseBranch: 'main',
    });

    expect(result.summary).toContain('Created branch');
    const branch = result.data as { name: string; baseBranch: string };
    expect(branch.name).toBe('fix/checkout-rounding');
    expect(branch.baseBranch).toBe('main');
  });

  it('is idempotent for the same branch name', async () => {
    const first = await call('create_branch', { name: 'fix/same', baseBranch: 'main' });
    const second = await call('create_branch', { name: 'fix/same', baseBranch: 'main' });

    const a = first.data as { createdAt: string };
    const b = second.data as { createdAt: string };
    expect(a.createdAt).toBe(b.createdAt);
  });

  it('rejects an invalid branch name at the registry boundary', () => {
    const tool = registry().get('create_branch');
    expect(tool!.inputSchema.safeParse({ name: 'has spaces' }).success).toBe(false);
    expect(tool!.inputSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('opens a pull request', async () => {
    const result = await call('open_pull_request', {
      title: 'Fix the checkout rounding',
      body: 'The total is rounded in the wrong order.',
      branch: 'fix/checkout-rounding',
      baseBranch: 'main',
    });

    expect(result.summary).toContain('pull request');
    const pullRequest = result.data as { number: number; url: string; state: string };
    expect(pullRequest.state).toBe('open');
    expect(pullRequest.url).toContain('/pull/');
  });
});

/* -------------------------------------------------------------------------- */
/* The diagnosis                                                              */
/* -------------------------------------------------------------------------- */

describe('the diagnosis', () => {
  it('correlates a deployment, its CI run and an issue', () => {
    const adapters = createMockOpsAdapters();
    const diagnose = createDiagnosis(adapters);

    const incident = diagnose({ service: 'checkout-api' });

    expect(incident.title).toContain('checkout-api');
    expect(incident.likelyCause).toBeTruthy();
    expect(incident.recommendedAction).toBeTruthy();
    expect(incident.evidence.length).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const first = createDiagnosis(createMockOpsAdapters())({ service: 'checkout-api' });
    const second = createDiagnosis(createMockOpsAdapters())({ service: 'checkout-api' });

    expect(first).toEqual(second);
  });

  it('throws a tool error for an unknown deployment', () => {
    const diagnose = createDiagnosis(createMockOpsAdapters());
    expect(() => diagnose({ deploymentId: 'dep_nope' })).toThrow(ToolError);
  });
});

/* -------------------------------------------------------------------------- */
/* The adapters are swappable                                                 */
/* -------------------------------------------------------------------------- */

describe('the adapter seam', () => {
  it('lets a different adapter back the same tools', async () => {
    const adapters = createMockOpsAdapters();
    const tools = createOpsTools(adapters);

    const list = tools.find((t) => t.name === 'list_deployments');
    expect(list).toBeDefined();

    // A tool built on a different adapter still works: the tools only
    // ever talk to the `OpsAdapters` interface.
    const custom = createOpsTools({
      ...adapters,
      deployments: {
        list: () => [
          {
            id: 'dep_custom',
            service: 'custom-service',
            environment: 'production',
            version: '9.9.9',
            actor: 'tester',
            status: 'failed',
            startedAt: '2026-01-01T00:00:00.000Z',
            finishedAt: null,
            summary: 'failed on purpose',
            commit: 'abc1234',
            ciRunId: null,
            logTail: ['boom'],
          },
        ],
        get: (id) => (id === 'dep_custom' ? undefined : undefined),
      },
    });

    const customList = custom.find((t) => t.name === 'list_deployments');
    const result = await customList!.handler({ limit: 5 });
    expect(result.summary).toContain('custom-service');
  });
});
