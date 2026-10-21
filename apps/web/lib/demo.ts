/**
 * Demo mode.
 *
 * A judge must be able to click through the whole product with no API
 * key, no GitHub token and no AWS credentials. The backend's seeded mock
 * tools make the *tools* work without secrets, but the agent still needs a
 * model to drive them — and a model needs a key.
 *
 * So the demo is a **scripted run**: a canned sequence of the same
 * timeline steps a real run produces. It is deliberately built from the
 * same `AgentEvent` shape the server returns, so the rendering path is
 * identical — a real run and a demo run go through exactly the same code.
 *
 * Everything the demo produces is labelled as a demo. The demo never
 * pretends to be a live run, and it never touches the server.
 */

import type { AgentEvent, PendingCall } from './api';

/** The request the demo run is answering. */
export const DEMO_REQUEST =
  'Check the failing checkout-api deployment, find the cause, and open a fix PR — but ask me before pushing anything.';

/** The demo run, expressed as the server's own event shape. */
export const DEMO_EVENTS: AgentEvent[] = [
  {
    type: 'text',
    text: "I'll start by finding the most recent deployment for checkout-api.",
  },
  {
    type: 'tool_call',
    id: 'demo-call-1',
    name: 'list_deployments',
    arguments: { service: 'checkout-api', limit: 3 },
  },
  {
    type: 'tool_result',
    id: 'demo-call-1',
    name: 'list_deployments',
    summary:
      'Found 3 deployment(s):\ndpl_8f21 checkout-api/prod failed (a1c4f7e) — rolled out to 1/3 replicas, then rolled back\ndpl_8f19 checkout-api/prod success (9b02d11) — rolled out to 3/3 replicas\ndpl_8f14 checkout-api/staging success (3ac55e0) — rolled out to 2/2 replicas',
    data: {
      count: 3,
      services: ['checkout-api', 'web-frontend', 'payments-worker'],
      deployments: [
        {
          id: 'dpl_8f21',
          service: 'checkout-api',
          environment: 'prod',
          version: '1.42.0',
          actor: 'ci-bot',
          status: 'failed',
          startedAt: '2026-10-21T09:12:04.000Z',
          finishedAt: '2026-10-21T09:14:51.000Z',
          summary: 'rolled out to 1/3 replicas, then rolled back',
          commit: 'a1c4f7e',
          ciRunId: 'ci_5512',
          logTail: [
            'deploy: uploading image checkout-api:1.42.0',
            'deploy: waiting for 3 replicas',
            'deploy: replica checkout-api-7d9  → CrashLoopBackOff (2 restarts)',
            'deploy: health check failed after 150s, rolling back',
          ],
        },
        {
          id: 'dpl_8f19',
          service: 'checkout-api',
          environment: 'prod',
          version: '1.41.0',
          actor: 'ci-bot',
          status: 'success',
          startedAt: '2026-10-20T16:02:11.000Z',
          finishedAt: '2026-10-20T16:06:38.000Z',
          summary: 'rolled out to 3/3 replicas',
          commit: '9b02d11',
          ciRunId: 'ci_5498',
          logTail: ['deploy: all replicas healthy'],
        },
        {
          id: 'dpl_8f14',
          service: 'checkout-api',
          environment: 'staging',
          version: '1.42.0-rc1',
          actor: 'r.alvarez',
          status: 'success',
          startedAt: '2026-10-20T11:47:02.000Z',
          finishedAt: '2026-10-20T11:50:09.000Z',
          summary: 'rolled out to 2/2 replicas',
          commit: '3ac55e0',
          ciRunId: 'ci_5481',
          logTail: ['deploy: all replicas healthy'],
        },
      ],
    },
  },
  {
    type: 'text',
    text: 'The prod deploy `dpl_8f21` failed. Let me pull the CI run that gated it.',
  },
  {
    type: 'tool_call',
    id: 'demo-call-2',
    name: 'get_ci_failure',
    arguments: { runId: 'ci_5512' },
  },
  {
    type: 'tool_result',
    id: 'demo-call-2',
    name: 'get_ci_failure',
    summary:
      'CI run ci_5512 on checkout-api (main) failed at test/integration/checkout: TypeError: Cannot read properties of undefined (reading "id")\nLog excerpt:\n  at chargeCard (src/payments/charge.js:41:18)',
    data: {
      runId: 'ci_5512',
      service: 'checkout-api',
      commit: 'a1c4f7e',
      branch: 'main',
      failedJob: 'test/integration',
      failedStep: 'checkout',
      error:
        "TypeError: Cannot read properties of undefined (reading 'id')",
      logExcerpt: [
        '  ✓ unit — 412 passed',
        '  ✓ lint — clean',
        '  ✗ integration/checkout — TypeError: Cannot read properties of undefined (reading "id")',
        '      at chargeCard (src/payments/charge.js:41:18)',
        '      at POST /api/checkout (src/routes/checkout.js:88:12)',
        '  412 tests, 1 failed',
      ],
      startedAt: '2026-10-21T09:08:40.000Z',
      jobs: [
        { name: 'build', status: 'success', steps: [] },
        { name: 'lint', status: 'success', steps: [] },
        {
          name: 'test/unit',
          status: 'success',
          steps: [{ name: 'run', status: 'success', durationMs: 14200 }],
        },
        {
          name: 'test/integration',
          status: 'failed',
          steps: [
            { name: 'seed', status: 'success', durationMs: 3800 },
            {
              name: 'checkout',
              status: 'failed',
              durationMs: 2260,
              output:
                "TypeError: Cannot read properties of undefined (reading 'id')",
            },
          ],
        },
      ],
    },
  },
  {
    type: 'text',
    text:
      'The failure is a missing customer object in the new checkout path. I will open a fix branch — that changes the repository, so I need your approval first.',
  },
  {
    type: 'tool_call',
    id: 'demo-call-3',
    name: 'create_branch',
    arguments: { name: 'fix/checkout-missing-customer', baseBranch: 'main' },
  },
  {
    type: 'confirmation_required',
    id: 'demo-call-3',
    name: 'create_branch',
    arguments: { name: 'fix/checkout-missing-customer', baseBranch: 'main' },
    message:
      'Create branch (name="fix/checkout-missing-customer", baseBranch="main")',
  },
];

/** The approval the demo run parks on. */
export const DEMO_PENDING: PendingCall = {
  callId: 'demo-call-3',
  name: 'create_branch',
  arguments: { name: 'fix/checkout-missing-customer', baseBranch: 'main' },
  message:
    'Create branch (name="fix/checkout-missing-customer", baseBranch="main")',
};

/** The events that follow the approval, used when the judge approves. */
export const DEMO_APPROVED_EVENTS: AgentEvent[] = [
  {
    type: 'approval_decision',
    id: 'demo-call-3',
    name: 'create_branch',
    approved: true,
    source: 'http',
  },
  {
    type: 'tool_result',
    id: 'demo-call-3',
    name: 'create_branch',
    summary:
      'Created branch "fix/checkout-missing-customer" from "main".',
    data: {
      name: 'fix/checkout-missing-customer',
      baseBranch: 'main',
      createdAt: '2026-10-21T09:21:14.000Z',
      headCommit: 'a1c4f7e',
    },
  },
  {
    type: 'text',
    text: 'Branch created. Now opening the pull request with the fix — that is visible to the team, so it needs your approval too.',
  },
  {
    type: 'tool_call',
    id: 'demo-call-4',
    name: 'open_pull_request',
    arguments: {
      title: 'fix: load customer before charging the card in checkout',
      body: 'The checkout route reads `customer.id` before the customer is loaded, so the new path throws a TypeError. This loads the customer first and adds a regression test.',
      branch: 'fix/checkout-missing-customer',
      baseBranch: 'main',
    },
  },
  {
    type: 'confirmation_required',
    id: 'demo-call-4',
    name: 'open_pull_request',
    arguments: {
      title: 'fix: load customer before charging the card in checkout',
      body: 'The checkout route reads `customer.id` before the customer is loaded, so the new path throws a TypeError. This loads the customer first and adds a regression test.',
      branch: 'fix/checkout-missing-customer',
      baseBranch: 'main',
    },
    message:
      'Open pull request (title="fix: load customer before charging the card in checkout", branch="fix/checkout-missing-customer", baseBranch="main")',
  },
];

/** The final assistant text of the demo run. */
export const DEMO_OUTCOME = `Pull request #212 is open against \`main\`.

**What happened:** the \`a1c4f7e\` deploy of checkout-api 1.42.0 failed in prod. CI run \`ci_5512\` failed at \`test/integration/checkout\` — the checkout route reads \`customer.id\` before the customer is loaded, so the new code path throws a TypeError.

**What I did:** created \`fix/checkout-missing-customer\` from \`main\` and opened PR #212, which loads the customer first and adds a regression test.

**Not done:** I did not merge or deploy anything.`;

/** The final events, used when every approval is granted. */
export const DEMO_FINAL_EVENTS: AgentEvent[] = [
  {
    type: 'approval_decision',
    id: 'demo-call-4',
    name: 'open_pull_request',
    approved: true,
    source: 'http',
  },
  {
    type: 'tool_result',
    id: 'demo-call-4',
    name: 'open_pull_request',
    summary:
      'Opened pull request #212: "fix: load customer before charging the card in checkout".',
    data: {
      id: 'pr_212',
      number: 212,
      title: 'fix: load customer before charging the card in checkout',
      body: 'The checkout route reads `customer.id` before the customer is loaded, so the new path throws a TypeError. This loads the customer first and adds a regression test.',
      branch: 'fix/checkout-missing-customer',
      baseBranch: 'main',
      state: 'open',
      author: 'muca',
      createdAt: '2026-10-21T09:24:02.000Z',
      url: 'https://github.com/acme/checkout-api/pull/212',
    },
  },
  {
    type: 'text',
    text: 'Pull request #212 is open against `main`.\n\n**What happened:** the `a1c4f7e` deploy of checkout-api 1.42.0 failed in prod. CI run `ci_5512` failed at `test/integration/checkout` — the checkout route reads `customer.id` before the customer is loaded, so the new code path throws a TypeError.\n\n**What I did:** created `fix/checkout-missing-customer` from `main` and opened PR #212, which loads the customer first and adds a regression test.\n\n**Not done:** I did not merge or deploy anything.',
  },
];

/** The demo tools, so the panel can show what a demo run would use. */
export const DEMO_TOOLS = [
  { name: 'list_deployments', destructive: false },
  { name: 'get_deployment', destructive: false },
  { name: 'get_ci_failure', destructive: false },
  { name: 'list_issues', destructive: false },
  { name: 'create_issue', destructive: false },
  { name: 'comment_on_issue', destructive: false },
  { name: 'create_branch', destructive: true },
  { name: 'open_pull_request', destructive: true },
  { name: 'diagnose_incident', destructive: false },
];
