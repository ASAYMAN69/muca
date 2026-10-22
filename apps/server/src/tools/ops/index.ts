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
  /**
   * Marks a tool that changes state. It is independent of `destructive`:
   * a write is not necessarily a consequential act.
   */
  writes?: boolean;
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
    writes: config.writes ?? false,
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

const getPullRequestArgs = z.object({
  number: z.number().int().positive(),
});

const listPullRequestsArgs = z.object({
  state: z.enum(['open', 'merged', 'closed']).optional(),
});

const listPullRequestReviewsArgs = z.object({
  number: z.number().int().positive(),
});

const listPullRequestCommentsArgs = z.object({
  number: z.number().int().positive(),
});

const listWorkflowRunsArgs = z.object({
  branch: z.string().min(1).max(100).optional(),
  service: z.string().min(1).max(80).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const listCommitsArgs = z.object({
  service: z.string().min(1).max(80).optional(),
  branch: z.string().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(50).default(10),
});

const pushCommitArgs = z.object({
  branch: z.string().min(1, 'branch must not be empty').max(100),
  path: z.string().min(1, 'path must not be empty').max(200),
  content: z.string().max(20000),
  message: z.string().min(1, 'message must not be empty').max(200),
  /** The pull request the commit belongs to, when it is known. */
  number: z.number().int().positive().optional(),
});

const replyToReviewArgs = z.object({
  number: z.number().int().positive(),
  /** The review to answer. */
  reviewId: z.string().min(1).max(120).optional(),
  /** The review comment to answer. */
  commentId: z.string().min(1).max(120).optional(),
  body: z.string().min(1, 'body must not be empty').max(2000),
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
      // It writes, but it is not consequential: opening an issue does not
      // need the user's approval.
      writes: true,
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
      // It writes, but it is not consequential.
      writes: true,
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
      // It writes *and* it is consequential: both axes are set.
      writes: true,
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
      // It writes *and* it is consequential: both axes are set.
      writes: true,
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

    /* ---------------------------------------------------------------- */
    /* The fix loop: read the review, check the CI, push the fix       */
    /* ---------------------------------------------------------------- */

    defineTool({
      name: 'list_pull_requests',
      title: 'List pull requests',
      description:
        'List pull requests, newest first, with their state, branch, files, review and ' +
        'CI summaries. Use it when asked what is open, how many there are, or what needs ' +
        'attention — you do not need a number first.',
      schema: listPullRequestsArgs,
      handler: (args) => {
        const pullRequests = adapters.pulls.list(args.state);
        if (pullRequests.length === 0) {
          return {
            summary: args.state
              ? `There are no ${args.state} pull requests.`
              : 'There are no pull requests.',
            data: { count: 0, pullRequests: [] },
          };
        }
        const summary = pullRequests
          .map(
            (p) =>
              `#${p.number} ${p.title} — ${p.state}, ${p.branch} → ${p.baseBranch}, ` +
              `by ${p.author}\n` +
              `  files: ${p.files.length > 0 ? p.files.join(', ') : '(none)'}\n` +
              `  reviews: ${p.reviewSummary ?? 'none'}\n` +
              `  checks: ${p.checksSummary ?? 'none'}`,
          )
          .join('\n');
        return {
          summary: `${pullRequests.length} pull request(s):\n${summary}`,
          data: { count: pullRequests.length, pullRequests },
        };
      },
    }),

    defineTool({
      name: 'get_pull_request',
      title: 'Get pull request',
      description:
        'Fetch one pull request: its state, the branch it is on, the files it changes, ' +
        'its diff, a summary of the reviews and a summary of the CI checks. ' +
        'Use it before acting on a pull request, and again after you push a fix.',
      schema: getPullRequestArgs,
      handler: (args) => {
        const pullRequest = adapters.pulls.get(args.number);
        if (!pullRequest) {
          throw new ToolError(`No pull request with number ${args.number}.`);
        }
        return {
          summary:
            `Pull request #${pullRequest.number} "${pullRequest.title}" is ${pullRequest.state} ` +
            `(${pullRequest.branch} → ${pullRequest.baseBranch}), by ${pullRequest.author}.\n` +
            `Files: ${pullRequest.files.length > 0 ? pullRequest.files.join(', ') : '(none)'}\n` +
            `Reviews: ${pullRequest.reviewSummary ?? 'none'}\n` +
            `Checks: ${pullRequest.checksSummary ?? 'none'}\n` +
            `Diff:\n${pullRequest.diff || '(no changes)'}`,
          data: pullRequest,
        };
      },
    }),

    defineTool({
      name: 'list_pull_request_reviews',
      title: 'List pull request reviews',
      description:
        'Every review on a pull request: who wrote it, whether it approved, requested ' +
        'changes or just commented, what it says, and when. Use it to find out what the ' +
        'reviewer asked for.',
      schema: listPullRequestReviewsArgs,
      handler: (args) => {
        if (!adapters.pulls.get(args.number)) {
          throw new ToolError(`No pull request with number ${args.number}.`);
        }
        const reviews = adapters.pulls.listReviews(args.number);
        if (reviews.length === 0) {
          return {
            summary: `Pull request #${args.number} has no reviews yet.`,
            data: { count: 0, number: args.number, reviews: [] },
          };
        }
        const summary = reviews
          .map((r) => `${r.reviewer} — ${r.state}: ${r.body}`)
          .join('\n');
        return {
          summary: `${reviews.length} review(s) on pull request #${args.number}:\n${summary}`,
          data: { count: reviews.length, number: args.number, reviews },
        };
      },
    }),

    defineTool({
      name: 'list_pull_request_comments',
      title: 'List pull request comments',
      description:
        'Every review comment on a pull request: the author, the file and the line it is ' +
        'on, what it says, when, and whether it has been resolved. Use it to see exactly ' +
        'which line the reviewer wants changed.',
      schema: listPullRequestCommentsArgs,
      handler: (args) => {
        if (!adapters.pulls.get(args.number)) {
          throw new ToolError(`No pull request with number ${args.number}.`);
        }
        const comments = adapters.pulls.listComments(args.number);
        if (comments.length === 0) {
          return {
            summary: `Pull request #${args.number} has no review comments.`,
            data: { count: 0, number: args.number, comments: [] },
          };
        }
        const summary = comments
          .map(
            (c) =>
              `${c.path}:${c.line} — ${c.author} (${c.resolved ? 'resolved' : 'open'}): ${c.body}`,
          )
          .join('\n');
        const open = comments.filter((c) => !c.resolved).length;
        return {
          summary:
            `${comments.length} review comment(s) on pull request #${args.number} ` +
            `(${open} still open):\n${summary}`,
          data: {
            count: comments.length,
            openCount: open,
            number: args.number,
            comments,
          },
        };
      },
    }),

    defineTool({
      name: 'list_workflow_runs',
      title: 'List workflow runs',
      description:
        'The CI runs of a branch or a service: the name of the workflow, whether it is ' +
        'queued, running, green or red, and — when it failed — the job and the step that ' +
        'failed with the log excerpt. Use it to say whether the fix is green.',
      schema: listWorkflowRunsArgs,
      handler: (args) => {
        const runs = adapters.ci.listRuns({
          branch: args.branch,
          service: args.service,
          limit: args.limit,
        });
        if (runs.length === 0) {
          return {
            summary: 'No CI runs found.',
            data: { count: 0, runs: [] },
          };
        }
        const summary = runs
          .map((run) => {
            const state =
              run.status === 'failure'
                ? `failed at ${run.failedJob}/${run.failedStep}`
                : run.status;
            return `${run.runId} ${run.name} on ${run.branch}: ${state}`;
          })
          .join('\n');
        return {
          summary: `${runs.length} CI run(s):\n${summary}`,
          data: { count: runs.length, runs },
        };
      },
    }),

    defineTool({
      name: 'list_commits',
      title: 'List commits',
      description:
        'The recent commits of a branch or a service: the sha, the message, the author, ' +
        'when, the files each one touched, and the deployment it produced when there was ' +
        'one. Use it to see what is already on a branch.',
      schema: listCommitsArgs,
      handler: (args) => {
        const commits = adapters.git.listCommits({
          branch: args.branch,
          service: args.service,
          limit: args.limit,
        });
        if (commits.length === 0) {
          return {
            summary: 'No commits found.',
            data: { count: 0, commits: [] },
          };
        }
        const summary = commits
          .map(
            (c) =>
              `${c.sha} ${c.message} (${c.author}, ${c.createdAt}) — ${c.files.join(', ')}` +
              `${c.deploymentId ? ` → deployment ${c.deploymentId}` : ''}`,
          )
          .join('\n');
        return {
          summary: `${commits.length} commit(s):\n${summary}`,
          data: { count: commits.length, commits },
        };
      },
    }),

    defineTool({
      name: 'push_commit',
      title: 'Push commit',
      description:
        'Replace a file on a branch and record the commit. The file content is replaced, ' +
        'the commit list grows, the pull request on that branch gets the new diff, and its ' +
        'CI runs are queued again. Use it to push the change a reviewer asked for.',
      schema: pushCommitArgs,
      // It writes. The policy engine decides whether the user has to
      // approve it, exactly as it does for every other write.
      writes: true,
      handler: (args) => {
        const commit = adapters.git.pushCommit({
          branch: args.branch,
          path: args.path,
          content: args.content,
          message: args.message,
        });

        const pullRequest =
          args.number !== undefined
            ? adapters.pulls.get(args.number)
            : adapters.pulls.getByBranch(args.branch);

        return {
          summary:
            `Pushed ${commit.sha} to "${args.branch}": ${commit.message}\n` +
            `Changed ${args.path}.\n` +
            (pullRequest
              ? `Pull request #${pullRequest.number} now changes: ` +
                `${pullRequest.files.length > 0 ? pullRequest.files.join(', ') : '(nothing)'}\n` +
                `Updated diff:\n${pullRequest.diff || '(no changes)'}`
              : 'No pull request is open on that branch.'),
          data: {
            commit,
            pullRequest: pullRequest ?? null,
            files: pullRequest?.files ?? [],
            diff: pullRequest?.diff ?? null,
          },
        };
      },
    }),

    defineTool({
      name: 'reply_to_review',
      title: 'Reply to review',
      description:
        'Reply to a review or to a review comment on a pull request. Replying to a ' +
        'review comment also marks it resolved. Use it to answer the reviewer after you ' +
        'have pushed the change they asked for.',
      schema: replyToReviewArgs,
      // It writes.
      writes: true,
      handler: (args) => {
        const reply = adapters.pulls.reply({
          number: args.number,
          reviewId: args.reviewId,
          commentId: args.commentId,
          body: args.body,
        });

        if (!reply) {
          throw new ToolError(
            args.commentId
              ? `No review comment with id ${args.commentId} on pull request #${args.number}.`
              : args.reviewId
                ? `No review with id ${args.reviewId} on pull request #${args.number}.`
                : `No pull request with number ${args.number}.`,
          );
        }

        const target = reply.commentId
          ? `comment ${reply.commentId}`
          : reply.reviewId
            ? `review ${reply.reviewId}`
            : `pull request #${reply.number}`;

        return {
          summary: `Replied to ${target}: ${reply.body}`,
          data: reply,
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
