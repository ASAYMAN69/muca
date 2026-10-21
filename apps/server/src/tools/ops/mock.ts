import type {
  Branch,
  CiFailure,
  CiJob,
  Deployment,
  Incident,
  Issue,
  IssueComment,
  IssueState,
  OpsAdapters,
  PullRequest,
} from './types.js';

/**
 * The seeded mock adapters.
 *
 * The whole point of this file is that a judge can run the entire product
 * with **zero credentials**. Everything is derived from a fixed seed and a
 * fixed clock, so the same call always returns the same thing:
 *
 *   - the same input always produces the same output (deterministic);
 *   - two server processes produce the same data (reproducible);
 *   - the data looks like a real incident (believable).
 *
 * A real adapter (GitHub, AWS ECS, a CI provider) implements the same
 * `OpsAdapters` interface and can be swapped in without touching a tool.
 */

/** The fixed "now" used by the seed. 2026-03-14T09:41:00Z. */
const SEED_EPOCH = Date.parse('2026-03-14T09:41:00.000Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** The services the mock knows about. */
export const MOCK_SERVICES = [
  'checkout-api',
  'web-storefront',
  'billing-worker',
  'notification-service',
] as const;

/**
 * A tiny, stable string hash. Used to derive "random-looking" but
 * reproducible values (ids, durations, which service a request is about).
 */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(items: readonly T[], seed: number): T {
  return items[seed % items.length]!;
}

function iso(offsetMs: number): string {
  return new Date(SEED_EPOCH + offsetMs).toISOString();
}

/* -------------------------------------------------------------------------- */
/* Seed data                                                                  */
/* -------------------------------------------------------------------------- */

const DEPLOYMENT_TEMPLATES: Array<
  Omit<Deployment, 'id' | 'startedAt' | 'finishedAt' | 'service' | 'version'>
> = [
  {
    environment: 'production',
    actor: 'ci-bot',
    status: 'failed',
    summary: 'rolled out to 1/3 replicas then rolled back',
    commit: 'a1c93f2',
    ciRunId: 'run_4821',
    logTail: [
      'deploy: applying revision 812 to checkout-api',
      'deploy: waiting for health checks (timeout 180s)',
      'deploy: health check failed for 2/3 replicas',
      'deploy: ERROR readiness probe failed: HTTP 503 from /healthz',
      'deploy: rolling back revision 811',
    ],
  },
  {
    environment: 'production',
    actor: 'sam.okafor',
    status: 'success',
    summary: 'rolled out to 3/3 replicas',
    commit: 'd47b0aa',
    ciRunId: 'run_4818',
    logTail: [
      'deploy: applying revision 813 to checkout-api',
      'deploy: 3/3 replicas ready',
      'deploy: release complete',
    ],
  },
  {
    environment: 'staging',
    actor: 'ci-bot',
    status: 'success',
    summary: 'rolled out to 2/2 replicas',
    commit: 'd47b0aa',
    ciRunId: 'run_4817',
    logTail: [
      'deploy: applying revision 807 to checkout-api',
      'deploy: 2/2 replicas ready',
    ],
  },
  {
    environment: 'production',
    actor: 'ci-bot',
    status: 'in_progress',
    summary: 'rolling out to 3/3 replicas',
    commit: 'e8b17c5',
    ciRunId: 'run_4822',
    logTail: [
      'deploy: applying revision 814 to checkout-api',
      'deploy: 1/3 replicas ready',
    ],
  },
  {
    environment: 'production',
    actor: 'ci-bot',
    status: 'success',
    summary: 'rolled out to 3/3 replicas',
    commit: '9f22d31',
    ciRunId: 'run_4809',
    logTail: [
      'deploy: applying revision 810 to checkout-api',
      'deploy: 3/3 replicas ready',
    ],
  },
  {
    environment: 'production',
    actor: 'ci-bot',
    status: 'failed',
    summary: 'failed during pre-deploy migration',
    commit: 'b30fa72',
    ciRunId: 'run_4795',
    logTail: [
      'deploy: running migration 20260314_add_refunds_index',
      'deploy: ERROR migration failed: relation "refunds" does not exist',
      'deploy: aborting release',
    ],
  },
];

const CI_FAILURE_TEMPLATES: Array<{
  failedJob: string;
  failedStep: string;
  error: string;
  logExcerpt: string[];
  jobs: CiJob[];
}> = [
  {
    failedJob: 'test',
    failedStep: 'unit-tests',
    error: 'Tests failed: 3 assertions failed in checkout/cart.spec.ts',
    logExcerpt: [
      '$ npm run test:unit',
      '  ✓ checkout/pricing.spec.ts (12 tests)',
      '  ✗ checkout/cart.spec.ts (18 tests | 3 failed)',
      '    expected 199 to equal 200 // Object.is equality',
      '    at checkout/cart.spec.ts:64:22',
      'Tests: 3 failed, 43 passed, 46 total',
    ],
    jobs: [
      {
        name: 'lint',
        status: 'success',
        steps: [
          { name: 'eslint', status: 'success', durationMs: 8_200 },
          { name: 'prettier --check', status: 'success', durationMs: 3_100 },
        ],
      },
      {
        name: 'test',
        status: 'failed',
        steps: [
          { name: 'install', status: 'success', durationMs: 21_400 },
          {
            name: 'unit-tests',
            status: 'failed',
            durationMs: 41_900,
            output:
              'Tests failed: 3 assertions failed in checkout/cart.spec.ts',
          },
          { name: 'integration-tests', status: 'skipped', durationMs: 0 },
        ],
      },
      {
        name: 'build',
        status: 'skipped',
        steps: [{ name: 'docker build', status: 'skipped', durationMs: 0 }],
      },
    ],
  },
  {
    failedJob: 'build',
    failedStep: 'docker-build',
    error: 'docker build failed: COPY failed: file not found in build context: src/middleware/tax.ts',
    logExcerpt: [
      '$ docker build -t app:${GIT_SHA} .',
      'Step 7/12 : COPY src/ ./src/',
      'ERROR: failed to compute cache key: "/src/middleware/tax.ts": not found',
    ],
    jobs: [
      {
        name: 'lint',
        status: 'success',
        steps: [{ name: 'eslint', status: 'success', durationMs: 7_800 }],
      },
      {
        name: 'test',
        status: 'success',
        steps: [{ name: 'unit-tests', status: 'success', durationMs: 39_100 }],
      },
      {
        name: 'build',
        status: 'failed',
        steps: [
          { name: 'install', status: 'success', durationMs: 19_800 },
          {
            name: 'docker-build',
            status: 'failed',
            durationMs: 12_400,
            output: 'docker build failed: COPY failed: file not found',
          },
        ],
      },
    ],
  },
  {
    failedJob: 'deploy',
    failedStep: 'rollout',
    error: 'deployment failed: readiness probe returned 503 for 180s',
    logExcerpt: [
      '$ kubectl rollout status deploy/checkout-api --timeout=180s',
      'Waiting for deployment "checkout-api" rollout to finish: 1 of 3 updated replicas are available...',
      'error: deployment "checkout-api" exceeded its progress deadline',
    ],
    jobs: [
      {
        name: 'build',
        status: 'success',
        steps: [{ name: 'docker-build', status: 'success', durationMs: 33_200 }],
      },
      {
        name: 'deploy',
        status: 'failed',
        steps: [
          {
            name: 'rollout',
            status: 'failed',
            durationMs: 180_000,
            output: 'readiness probe returned 503',
          },
        ],
      },
    ],
  },
];

const ISSUE_TEMPLATES: Array<
  Omit<Issue, 'id' | 'createdAt' | 'updatedAt' | 'comments' | 'number'>
> = [
  {
    title: 'Checkout total rounds up to the wrong amount',
    body: 'Customers on the cart page see the total rounded up by one cent.\n\nSteps:\n1. Add two items with a 12.50 unit price\n2. Open the cart\n3. The total shows 25.01 instead of 25.00',
    state: 'open',
    labels: ['bug', 'checkout', 'regression'],
    author: 'jules.martins',
  },
  {
    title: 'Refunds table missing on a fresh staging database',
    body: 'The 20260314_add_refunds_index migration assumes the refunds table exists.\nOn a brand new database the migration aborts the whole release.',
    state: 'open',
    labels: ['bug', 'migrations'],
    author: 'sam.okafor',
  },
  {
    title: 'Add a healthz endpoint that checks the tax service',
    body: 'The readiness probe only checks the process, not the downstream tax call.\nIt would have caught the 503 rollout failure an hour earlier.',
    state: 'open',
    labels: ['enhancement', 'observability'],
    author: 'priya.raman',
  },
  {
    title: 'Tax middleware was moved without updating the Dockerfile',
    body: 'src/middleware/tax.ts was moved to src/services/tax.ts, but the Dockerfile still copies the old path.',
    state: 'open',
    labels: ['bug', 'build'],
    author: 'jules.martins',
  },
  {
    title: 'Bump the base image to node 22',
    body: 'The base image is two LTS versions behind.',
    state: 'closed',
    labels: ['chore', 'dependencies'],
    author: 'priya.raman',
  },
  {
    title: 'Investigate elevated p99 latency on /cart',
    body: 'p99 went from 180ms to 940ms after the 09:12 deploy. No traffic increase.',
    state: 'open',
    labels: ['performance', 'checkout'],
    author: 'sam.okafor',
  },
];

/* -------------------------------------------------------------------------- */
/* The mock adapters                                                          */
/* -------------------------------------------------------------------------- */

export interface MockOpsOptions {
  /** Which service the "current" incident is about. */
  primaryService?: string;
  /** The branch a fix would be opened from. */
  baseBranch?: string;
}

/**
 * Builds the seeded mock adapters.
 *
 * The returned object is stateful: issues, branches and pull requests
 * created through it are visible to later calls. That is what makes the
 * agent's multi-step workflow (list → read → create branch → open PR)
 * behave like a real one.
 */
export function createMockOpsAdapters(options: MockOpsOptions = {}): OpsAdapters {
  const primaryService = options.primaryService ?? MOCK_SERVICES[0];
  const baseBranch = options.baseBranch ?? 'main';

  /* ---------------------------------------------------------------- */
  /* Deployments                                                      */
  /* ---------------------------------------------------------------- */

  const deployments: Deployment[] = DEPLOYMENT_TEMPLATES.map((template, index) => {
    const service = index === 0 ? primaryService : pick(MOCK_SERVICES, hash(template.commit));
    const startedAt = SEED_EPOCH - (index + 1) * 37 * MINUTE;
    const finished =
      template.status === 'in_progress'
        ? null
        : iso(startedAt + (4 + (index % 5)) * MINUTE);
    return {
      ...template,
      id: `dep_${hash(template.commit + service)}_${index + 1}`,
      service,
      version: `1.${14 - index}.${index}`,
      startedAt: iso(startedAt),
      finishedAt: finished,
    };
  });

  /* ---------------------------------------------------------------- */
  /* CI failures                                                      */
  /* ---------------------------------------------------------------- */

  // The CI run ids line up with the deployments they gated, so
  // `get_ci_failure(deployment.ciRunId)` always resolves.
  const ciFailures: CiFailure[] = CI_FAILURE_TEMPLATES.map((template, index) => {
    const deployment = deployments[index];
    const service = index === 0 ? primaryService : deployment?.service ?? primaryService;
    const branch = index === 1 ? 'feature/tax-middleware' : baseBranch;
    return {
      runId: deployment?.ciRunId ?? `run_${4800 + index * 7}`,
      service,
      commit: deployment?.commit ?? 'a1c93f2',
      branch,
      failedJob: template.failedJob,
      failedStep: template.failedStep,
      error: template.error,
      logExcerpt: template.logExcerpt,
      startedAt: deployment?.startedAt ?? iso(-60 * MINUTE),
      jobs: template.jobs,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Issues                                                           */
  /* ---------------------------------------------------------------- */

  let issueCounter = 100;
  const issues: Issue[] = ISSUE_TEMPLATES.map((template, index) => {
    const number = 412 + index;
    const createdAt = SEED_EPOCH - (index + 1) * 5 * HOUR;
    const comments: IssueComment[] =
      index === 0
        ? [
            {
              id: `cmt_${number}_1`,
              author: 'sam.okafor',
              body: 'Confirmed on staging too. Looks like a rounding order bug.',
              createdAt: iso(createdAt + 45 * MINUTE),
            },
          ]
        : [];
    return {
      ...template,
      id: `iss_${number}`,
      number,
      createdAt: iso(createdAt),
      updatedAt: iso(createdAt + (comments.length > 0 ? 45 * MINUTE : 0)),
      comments,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Branches and pull requests                                       */
  /* ---------------------------------------------------------------- */

  const branches: Branch[] = [
    {
      name: baseBranch,
      baseBranch: 'main',
      createdAt: iso(-30 * 24 * HOUR),
      headCommit: 'd47b0aa',
    },
    {
      name: 'feature/tax-middleware',
      baseBranch,
      createdAt: iso(-3 * HOUR),
      headCommit: 'c1a5e88',
    },
  ];

  let pullRequestCounter = 0;
  const pullRequests: PullRequest[] = [];

  return {
    deployments: {
      list(service: string, limit: number): Deployment[] {
        const filtered = service
          ? deployments.filter((d) => d.service === service)
          : deployments;
        return filtered.slice(0, limit);
      },
      get(deploymentId: string): Deployment | undefined {
        return deployments.find((d) => d.id === deploymentId);
      },
    },

    ci: {
      listFailures(service: string, limit: number): CiFailure[] {
        const filtered = service
          ? ciFailures.filter((f) => f.service === service)
          : ciFailures;
        return filtered.slice(0, limit);
      },
      getFailure(runId: string): CiFailure | undefined {
        return ciFailures.find((f) => f.runId === runId);
      },
    },

    issues: {
      list(state: IssueState | 'all', limit: number): Issue[] {
        const filtered =
          state === 'all' ? issues : issues.filter((i) => i.state === state);
        return filtered.slice(0, limit);
      },
      create(input: { title: string; body: string; labels: string[] }): Issue {
        issueCounter += 1;
        const number = 412 + issueCounter;
        const now = iso(0);
        const issue: Issue = {
          id: `iss_${number}`,
          number,
          title: input.title,
          body: input.body,
          state: 'open',
          labels: input.labels,
          author: 'muca-ops-copilot',
          createdAt: now,
          updatedAt: now,
          comments: [],
        };
        issues.unshift(issue);
        return issue;
      },
      comment(issueNumber: number, body: string): Issue | undefined {
        const issue = issues.find((i) => i.number === issueNumber);
        if (!issue) return undefined;
        const comment: IssueComment = {
          id: `cmt_${issueNumber}_${issue.comments.length + 1}`,
          author: 'muca-ops-copilot',
          body,
          createdAt: iso(0),
        };
        issue.comments.push(comment);
        issue.updatedAt = comment.createdAt;
        return issue;
      },
    },

    git: {
      createBranch(input: { name: string; baseBranch: string }): Branch {
        const existing = branches.find((b) => b.name === input.name);
        if (existing) return existing;
        const branch: Branch = {
          name: input.name,
          baseBranch: input.baseBranch,
          createdAt: iso(0),
          headCommit: 'f10c2de',
        };
        branches.push(branch);
        return branch;
      },
      listBranches(): Branch[] {
        return branches.slice();
      },
      openPullRequest(input: {
        title: string;
        body: string;
        branch: string;
        baseBranch: string;
      }): PullRequest {
        pullRequestCounter += 1;
        const number = 700 + pullRequestCounter;
        const pullRequest: PullRequest = {
          id: `pr_${number}`,
          number,
          title: input.title,
          body: input.body,
          branch: input.branch,
          baseBranch: input.baseBranch,
          state: 'open',
          author: 'muca-ops-copilot',
          createdAt: iso(0),
          url: `https://github.com/acme/checkout-api/pull/${number}`,
        };
        pullRequests.push(pullRequest);
        return pullRequest;
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Derived incidents                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Builds the incident summary for a deployment + CI failure pair.
 *
 * This is the "correlate across services" step: the deployment says the
 * rollout failed, the CI run says which test failed, and the incident
 * ties the two together with a likely cause and a next action.
 */
export function buildIncident(
  deployment: Deployment,
  failure: CiFailure | undefined,
  issue: Issue | undefined,
): Incident {
  const likelyCause = failure
    ? `${failure.failedJob}/${failure.failedStep}: ${failure.error}`
    : deployment.logTail.find((line) => line.includes('ERROR')) ??
      'No explicit error was recorded in the deployment log.';

  const recommendedAction = issue
    ? `See issue #${issue.number} ("${issue.title}").`
    : 'Open a fix branch and a pull request with the diagnosis.';

  return {
    id: `inc_${hash(deployment.id + (failure?.runId ?? ''))}`,
    title: `${deployment.service} ${deployment.environment} deployment failed`,
    summary: deployment.summary,
    source: deployment.id,
    service: deployment.service,
    severity: failure ? 'high' : 'medium',
    detectedAt: deployment.startedAt,
    likelyCause,
    recommendedAction,
    evidence: [
      `deployment ${deployment.id} (${deployment.commit})`,
      ...(failure ? [`ci run ${failure.runId} — ${failure.failedStep}`] : []),
      ...(issue ? [`issue #${issue.number}`] : []),
    ],
  };
}
