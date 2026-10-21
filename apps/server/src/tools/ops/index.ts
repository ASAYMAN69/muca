import { z } from 'zod';

import { ToolError, type MucaTool, type ToolResult } from '../registry.js';
import { buildIncident, createMockOpsAdapters, MOCK_SERVICES } from './mock.js';
import type { OpsAdapters } from './types.js';

/**
 * The Ops Copilot tool set.
 *
 * Muca helps a solo developer or a small team triage a failing deployment
 * or CI run, and — only with an explicit approval — open a branch and a
 * pull request with the fix.
 *
 * The domain is deployment / CI failure triage. The tools read evidence
 * from a seeded mock adapter (no credentials required) and can act on it.
 *
 * Destructive tools (`create_branch`, `open_pull_request`) are marked with
 * `destructive: true`, so the agent asks for approval before running them.
 */

/**
 * Builds a tool with its argument types inferred from the Zod schema.
 * The handler receives the parsed, typed arguments.
 */
function defineTool<Shape extends z.ZodRawShape>(config: {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<Shape>;
  destructive?: boolean;
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
  ) => Promise<ToolResult> | ToolResult;
}): MucaTool {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.schema,
    destructive: config.destructive ?? false,
    handler: config.handler as MucaTool['handler'],
  };
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const listDeploymentsArgs = z.object({
  service: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe('Filter by service name. Omit to list every service.'),
  limit: z.number().int().min(1).max(50).default(10),
});

const getDeploymentArgs = z.object({
  deploymentId: z.string().min(1).max(120),
});

const getCiFailureArgs = z.object({
  runId: z.string().min(1).max(120),
});

const listIssuesArgs = z.object({
  state: z.enum(['open', 'closed', 'all']).default('open'),
  limit: z.number().int().min(1).max(50).default(20),
});

const createIssueArgs = z.object({
  title: z.string().min(1, 'title must not be empty').max(160),
  body: z.string().max(4000).default(''),
  labels: z.array(z.string().min(1)).max(10).default([]),
});

const commentOnIssueArgs = z.object({
  issueNumber: z.number().int().positive(),
  body: z.string().min(1, 'comment must not be empty').max(2000),
});

const createBranchArgs = z.object({
  name: z
    .string()
    .min(1, 'branch name must not be empty')
    .max(100)
    .regex(
      /^[A-Za-z0-9._\-/]+$/,
      'branch name may only contain letters, digits, dot, dash, underscore and slash',
    ),
  baseBranch: z.string().min(1).max(100).default('main'),
});

const openPullRequestArgs = z.object({
  title: z.string().min(1, 'title must not be empty').max(160),
  body: z.string().max(4000).default(''),
  branch: z.string().min(1).max(100),
  baseBranch: z.string().min(1).max(100).default('main'),
});

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Builds the Ops Copilot tools against a set of adapters.
 *
 * @param adapters The adapter set. Defaults to the seeded mock, which
 *   needs no credentials and returns the same data every time.
 */
export function createOpsTools(adapters: OpsAdapters = createMockOpsAdapters()): MucaTool[] {
  return [
    defineTool({
      name: 'list_deployments',
      title: 'List deployments',
      description:
        'List recent deployments for a service (or for every service), newest first, ' +
        'with their status, commit and a short log tail. Use this to find a failing deploy.',
      schema: listDeploymentsArgs,
      handler: (args) => {
        const deployments = adapters.deployments.list(args.service ?? '', args.limit);
        if (deployments.length === 0) {
          return {
            summary: args.service
              ? `No deployments found for "${args.service}".`
              : 'No deployments found.',
            data: { count: 0, deployments: [] },
          };
        }
        const summary = deployments
          .map(
            (d) =>
              `${d.id} ${d.service}/${d.environment} ${d.status} (${d.commit}) — ${d.summary}`,
          )
          .join('\n');
        return {
          summary: `Found ${deployments.length} deployment(s):\n${summary}`,
          data: {
            count: deployments.length,
            services: MOCK_SERVICES,
            deployments,
          },
        };
      },
    }),

    defineTool({
      name: 'get_deployment',
      title: 'Get deployment',
      description:
        'Fetch one deployment by id, with its status, commit, CI run and log tail. ' +
        'Use it after list_deployments to see why a deployment failed.',
      schema: getDeploymentArgs,
      handler: (args) => {
        const deployment = adapters.deployments.get(args.deploymentId);
        if (!deployment) {
          throw new ToolError(`No deployment with id ${args.deploymentId}.`);
        }
        return {
          summary:
            `Deployment ${deployment.id} (${deployment.service}/${deployment.environment}) ` +
            `is ${deployment.status}. ${deployment.summary}.\n` +
            `Commit ${deployment.commit}${deployment.ciRunId ? `, CI run ${deployment.ciRunId}` : ''}.\n` +
            `Log tail:\n${deployment.logTail.join('\n')}`,
          data: deployment,
        };
      },
    }),

    defineTool({
      name: 'get_ci_failure',
      title: 'Get CI failure',
      description:
        'Fetch the failing CI run: which job failed, which step failed, the error, and ' +
        'the log excerpt around it. This is the evidence behind a deployment failure.',
      schema: getCiFailureArgs,
      handler: (args) => {
        const failure = adapters.ci.getFailure(args.runId);
        if (!failure) {
          throw new ToolError(`No CI run with id ${args.runId}.`);
        }
        return {
          summary:
            `CI run ${failure.runId} on ${failure.service} (${failure.branch}) failed at ` +
            `${failure.failedJob}/${failure.failedStep}: ${failure.error}\n` +
            `Log excerpt:\n${failure.logExcerpt.join('\n')}`,
          data: failure,
        };
      },
    }),

    defineTool({
      name: 'list_issues',
      title: 'List issues',
      description:
        'List open or closed issues, newest first. Use it to find an existing ticket ' +
        'that already describes the failure before opening a new one.',
      schema: listIssuesArgs,
      handler: (args) => {
        const issues = adapters.issues.list(args.state, args.limit);
        if (issues.length === 0) {
          return {
            summary: `No ${args.state} issues found.`,
            data: { count: 0, state: args.state, issues: [] },
          };
        }
        const summary = issues
          .map((i) => `#${i.number} [${i.state}] ${i.title} (${i.labels.join(', ')})`)
          .join('\n');
        return {
          summary: `Found ${issues.length} ${args.state} issue(s):\n${summary}`,
          data: { count: issues.length, state: args.state, issues },
        };
      },
    }),

    defineTool({
      name: 'create_issue',
      title: 'Create issue',
      description:
        'Open a new issue describing a failure or a fix. Use it to record a diagnosis ' +
        'that the team should look at.',
      schema: createIssueArgs,
      handler: (args) => {
        const issue = adapters.issues.create({
          title: args.title,
          body: args.body,
          labels: args.labels,
        });
        return {
          summary: `Opened issue #${issue.number}: "${issue.title}".`,
          data: issue,
        };
      },
    }),

    defineTool({
      name: 'comment_on_issue',
      title: 'Comment on issue',
      description:
        'Add a comment to an existing issue. Use it to attach a diagnosis or a link ' +
        'to a pull request.',
      schema: commentOnIssueArgs,
      handler: (args) => {
        const issue = adapters.issues.comment(args.issueNumber, args.body);
        if (!issue) {
          throw new ToolError(`No issue with number ${args.issueNumber}.`);
        }
        return {
          summary: `Commented on issue #${issue.number}.`,
          data: issue,
        };
      },
    }),

    defineTool({
      name: 'create_branch',
      title: 'Create branch',
      description:
        'Create a git branch from a base branch. This changes the repository, so the ' +
        'user is asked to approve it first.',
      schema: createBranchArgs,
      destructive: true,
      handler: (args) => {
        const branch = adapters.git.createBranch({
          name: args.name,
          baseBranch: args.baseBranch,
        });
        return {
          summary: `Created branch "${branch.name}" from "${branch.baseBranch}".`,
          data: branch,
        };
      },
    }),

    defineTool({
      name: 'open_pull_request',
      title: 'Open pull request',
      description:
        'Open a pull request for a branch. This is visible to the whole team, so the ' +
        'user is asked to approve it first.',
      schema: openPullRequestArgs,
      destructive: true,
      handler: (args) => {
        const pullRequest = adapters.git.openPullRequest({
          title: args.title,
          body: args.body,
          branch: args.branch,
          baseBranch: args.baseBranch,
        });
        return {
          summary: `Opened pull request #${pullRequest.number}: "${pullRequest.title}".`,
          data: pullRequest,
        };
      },
    }),
  ];
}

/**
 * The diagnosis tool.
 *
 * This is the long-running one: it correlates a deployment, its CI run and
 * the matching issue into a single incident. It is exposed both as a
 * normal tool (fast path) and as an MCP **task** (see `src/mcp/tasks.ts`).
 */
export function createDiagnosis(adapters: OpsAdapters) {
  return function diagnose(input: {
    deploymentId?: string;
    service?: string;
  }): ReturnType<typeof buildIncident> {
    const deployment = input.deploymentId
      ? adapters.deployments.get(input.deploymentId)
      : adapters.deployments.list(input.service ?? '', 1)[0];

    if (!deployment) {
      throw new ToolError(
        input.deploymentId
          ? `No deployment with id ${input.deploymentId}.`
          : `No deployment found for "${input.service ?? 'any service'}".`,
      );
    }

    const failure = deployment.ciRunId
      ? adapters.ci.getFailure(deployment.ciRunId)
      : adapters.ci.listFailures(deployment.service, 1)[0];

    const issue = adapters.issues.list('open', 50).find((candidate) => {
      const title = candidate.title.toLowerCase();
      const body = candidate.body.toLowerCase();
      return (
        title.includes('checkout') ||
        body.includes('migration') ||
        body.includes('readiness') ||
        body.includes('rounding')
      );
    });

    return buildIncident(deployment, failure, issue);
  };
}
