/**
 * Artifact cards.
 *
 * A judge should see the outcome without expanding anything. This module
 * turns a raw tool result into a small, typed structure a card can render:
 * a title, a status, and a handful of key fields.
 *
 * The shapes are matched by *shape*, not by an exhaustive list of tool
 * names: the backend is evolving, and a card for an unknown result is
 * still better than raw JSON.
 */

export type ArtifactStatus =
  | 'success'
  | 'failed'
  | 'in_progress'
  | 'queued'
  | 'cancelled'
  | 'neutral'
  | 'unknown';

export interface ArtifactField {
  label: string;
  value: string;
  /** Renders the value in a monospace face. */
  mono?: boolean;
  /** The value is long — render it on its own line. */
  block?: boolean;
}

/**
 * A row inside a card.
 *
 * Some results are lists of things that each deserve a line: a review, a
 * comment, a CI run, a commit. A row carries its own badge, because the
 * badge is the point: which review asked for a change, which run is red.
 */
export interface ArtifactRow {
  /** The row's heading: the reviewer, the workflow name, the message. */
  title: string;
  /** A quiet line under the heading. */
  meta?: string;
  /** A status badge. The label carries the meaning, not only the colour. */
  badge?: {
    label: string;
    tone: 'success' | 'failed' | 'warn' | 'neutral';
  };
  /** A short paragraph. */
  body?: string;
  /** A monospace block that scrolls sideways and never reflows. */
  code?: string;
  /** Small key/value rows. */
  fields?: ArtifactField[];
  /** Short monospace lines. */
  lines?: string[];
}

export interface Artifact {
  /** A stable id, so React can key the card. */
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  status: ArtifactStatus;
  fields: ArtifactField[];
  /** Optional body text — a log excerpt, a description. */
  body?: string;
  /** Optional list of lines — log tails, job lists. */
  lines?: string[];
  /** A monospace block: a diff. It scrolls sideways and never reflows. */
  code?: string;
  /** Rows: reviews, comments, CI runs, commits. */
  rows?: ArtifactRow[];
  /** The raw data, for the expandable section. */
  raw?: unknown;
}

/** Formats a value for a card field. */
function text(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(text).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusFrom(value: unknown): ArtifactStatus {
  switch (value) {
    case 'success':
    case 'succeeded':
    case 'passed':
      return 'success';
    case 'failed':
    case 'failure':
    case 'error':
      return 'failed';
    case 'in_progress':
    case 'running':
    case 'working':
      return 'in_progress';
    case 'queued':
    case 'pending':
    case 'input_required':
      return 'queued';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'neutral';
  }
}

/**
 * Builds an artifact from a tool result.
 *
 * Returns null when the payload carries nothing worth a card, so the
 * caller can fall back to the plain summary.
 */
export function buildArtifact(input: {
  id: string;
  toolName: string;
  data: unknown;
}): Artifact | null {
  const { id, toolName, data } = input;
  if (!isRecord(data)) return null;

  const card = buildSpecificCard(id, toolName, data);
  if (card) return card;

  // A list-shaped result: show the count and the first few items.
  const list = pickArray(data);
  if (list) {
    return {
      id,
      kind: 'collection',
      title: titleForTool(toolName),
      subtitle: `${list.length} item${list.length === 1 ? '' : 's'}`,
      status: 'neutral',
      fields: [],
      lines: list.slice(0, 6).map((item) => summarizeItem(item)),
      raw: data,
    };
  }

  // A flat object: show the scalar fields.
  const fields = Object.entries(data)
    .filter(([, value]) => typeof value !== 'object' || value === null)
    .map(([key, value]) => ({ label: key, value: text(value) }));
  if (fields.length === 0) return null;

  return {
    id,
    kind: 'object',
    title: titleForTool(toolName),
    status: 'neutral',
    fields,
    raw: data,
  };
}

/** Finds the first array of objects in a payload. */
function pickArray(data: Record<string, unknown>): unknown[] | null {
  for (const value of Object.values(data)) {
    if (Array.isArray(value) && value.length > 0) return value;
  }
  return null;
}

function summarizeItem(item: unknown): string {
  if (!isRecord(item)) return text(item);
  const title =
    text(item.title) ??
    text(item.name) ??
    text(item.id) ??
    text(item.summary) ??
    '';
  const status = item.status ? ` [${text(item.status)}]` : '';
  return `${title}${status}`;
}

function titleForTool(name: string): string {
  return name
    .split(/[._]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/* -------------------------------------------------------------------------- */
/* Domain-specific cards                                                      */
/* -------------------------------------------------------------------------- */

function buildSpecificCard(
  id: string,
  toolName: string,
  data: Record<string, unknown>,
): Artifact | null {
  switch (toolName) {
    case 'list_deployments':
      return deploymentListCard(id, data);
    case 'get_deployment':
      return deploymentCard(id, data);
    case 'get_ci_failure':
      return ciFailureCard(id, data);
    case 'list_issues':
      return issueListCard(id, data);
    case 'create_issue':
    case 'comment_on_issue':
      return issueCard(id, data);
    case 'create_branch':
      return branchCard(id, data);
    case 'open_pull_request':
      return pullRequestCard(id, data);
    case 'get_pull_request':
      return pullRequestDetailCard(id, data);
    case 'list_pull_request_reviews':
      return reviewListCard(id, data);
    case 'list_pull_request_comments':
      return reviewCommentListCard(id, data);
    case 'reply_to_review':
      return reviewReplyCard(id, data);
    case 'list_workflow_runs':
      return workflowRunListCard(id, data);
    case 'list_commits':
      return commitListCard(id, data);
    case 'push_commit':
      return pushCommitCard(id, data);
    case 'diagnose_incident':
      return incidentCard(id, data);
    default:
      return null;
  }
}

function deploymentListCard(
  id: string,
  data: Record<string, unknown>,
): Artifact | null {
  const deployments = data.deployments;
  if (!Array.isArray(deployments)) return null;
  const failed = deployments.filter(
    (d) => isRecord(d) && d.status === 'failed',
  ).length;

  return {
    id,
    kind: 'deployment-list',
    title: 'Deployments',
    subtitle: `${deployments.length} recent, ${failed} failed`,
    status: failed > 0 ? 'failed' : 'success',
    fields: [],
    lines: deployments.slice(0, 6).map((d) => {
      if (!isRecord(d)) return text(d);
      return `${text(d.id)} · ${text(d.service)}/${text(d.environment)} · ${text(d.status)} · ${text(d.commit)}`;
    }),
    raw: data,
  };
}

function deploymentCard(id: string, data: Record<string, unknown>): Artifact {
  const status = statusFrom(data.status);
  const fields: ArtifactField[] = [
    { label: 'Service', value: text(data.service), mono: true },
    { label: 'Environment', value: text(data.environment), mono: true },
    { label: 'Version', value: text(data.version), mono: true },
    { label: 'Commit', value: text(data.commit), mono: true },
  ];
  if (data.ciRunId) {
    fields.push({ label: 'CI run', value: text(data.ciRunId), mono: true });
  }
  if (data.actor) {
    fields.push({ label: 'Triggered by', value: text(data.actor) });
  }

  return {
    id,
    kind: 'deployment',
    title: `Deployment ${text(data.id)}`,
    subtitle: text(data.summary) || undefined,
    status,
    fields,
    lines: Array.isArray(data.logTail) ? (data.logTail as string[]) : undefined,
    raw: data,
  };
}

function ciFailureCard(id: string, data: Record<string, unknown>): Artifact {
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const fields: ArtifactField[] = [
    { label: 'Failed job', value: text(data.failedJob), mono: true },
    { label: 'Failed step', value: text(data.failedStep), mono: true },
    { label: 'Branch', value: text(data.branch), mono: true },
    { label: 'Commit', value: text(data.commit), mono: true },
  ];

  return {
    id,
    kind: 'ci-failure',
    title: `CI run ${text(data.runId)}`,
    subtitle: text(data.error) || undefined,
    status: 'failed',
    fields,
    body: Array.isArray(data.logExcerpt)
      ? (data.logExcerpt as string[]).join('\n')
      : undefined,
    lines: jobs.map((job) => {
      if (!isRecord(job)) return text(job);
      return `${text(job.name)} — ${text(job.status)}`;
    }),
    raw: data,
  };
}

function issueListCard(id: string, data: Record<string, unknown>): Artifact | null {
  const issues = data.issues;
  if (!Array.isArray(issues)) return null;
  return {
    id,
    kind: 'issue-list',
    title: 'Issues',
    subtitle: `${issues.length} ${text(data.state) || 'returned'}`,
    status: 'neutral',
    fields: [],
    lines: issues.slice(0, 8).map((issue) => {
      if (!isRecord(issue)) return text(issue);
      return `#${text(issue.number)} · ${text(issue.state)} · ${text(issue.title)}`;
    }),
    raw: data,
  };
}

function issueCard(id: string, data: Record<string, unknown>): Artifact {
  return {
    id,
    kind: 'issue',
    title: `#${text(data.number)} · ${text(data.title)}`,
    subtitle: data.state ? `State: ${text(data.state)}` : undefined,
    status: data.state === 'open' ? 'in_progress' : 'neutral',
    fields: [
      { label: 'Author', value: text(data.author) },
      {
        label: 'Labels',
        value: Array.isArray(data.labels)
          ? (data.labels as string[]).join(', ') || '—'
          : '—',
      },
    ],
    body: typeof data.body === 'string' ? data.body : undefined,
    raw: data,
  };
}

function branchCard(id: string, data: Record<string, unknown>): Artifact {
  return {
    id,
    kind: 'branch',
    title: `Branch ${text(data.name)}`,
    subtitle: `from ${text(data.baseBranch)}`,
    status: 'success',
    fields: [
      { label: 'Head commit', value: text(data.headCommit), mono: true },
      { label: 'Created', value: text(data.createdAt), mono: true },
    ],
    raw: data,
  };
}

function pullRequestCard(id: string, data: Record<string, unknown>): Artifact {
  return {
    id,
    kind: 'pull-request',
    title: `PR #${text(data.number)} · ${text(data.title)}`,
    subtitle: `${text(data.branch)} → ${text(data.baseBranch)}`,
    status: data.state === 'open' ? 'success' : 'neutral',
    fields: [
      { label: 'State', value: text(data.state) },
      { label: 'Author', value: text(data.author) },
      { label: 'URL', value: text(data.url), mono: true, block: true },
    ],
    body: typeof data.body === 'string' ? data.body : undefined,
    raw: data,
  };
}

function incidentCard(id: string, data: Record<string, unknown>): Artifact {
  const severity = text(data.severity);
  const status: ArtifactStatus =
    severity === 'high' ? 'failed' : severity === 'medium' ? 'queued' : 'neutral';
  const fields: ArtifactField[] = [
    { label: 'Severity', value: severity },
    { label: 'Service', value: text(data.service), mono: true },
    { label: 'Source', value: text(data.source), mono: true },
  ];

  return {
    id,
    kind: 'incident',
    title: text(data.title),
    subtitle: text(data.summary) || undefined,
    status,
    fields,
    body:
      typeof data.likelyCause === 'string' ? data.likelyCause : undefined,
    lines: Array.isArray(data.evidence)
      ? (data.evidence as string[]).map((line) => `• ${line}`)
      : undefined,
    raw: data,
  };
}

/* -------------------------------------------------------------------------- */
/* The fix loop: pull requests, reviews, CI runs, commits                     */
/* -------------------------------------------------------------------------- */

/** The base branch of a pull request, whichever name it arrived under. */
function baseOf(data: Record<string, unknown>): string {
  return text(data.baseBranch ?? data.base);
}

/** The file a review comment is on, whichever name it arrived under. */
function pathOf(data: Record<string, unknown>): string {
  return text(data.path ?? data.file);
}

/**
 * A pull request, with its diff.
 *
 * The diff is the point: it is what a reviewer reads, so it gets its own
 * monospace block that scrolls sideways and never reflows.
 */
function pullRequestDetailCard(
  id: string,
  data: Record<string, unknown>,
): Artifact {
  const files = Array.isArray(data.files) ? (data.files as string[]) : [];
  const fields: ArtifactField[] = [
    { label: 'State', value: text(data.state) },
    { label: 'Author', value: text(data.author) },
    { label: 'Files', value: files.length > 0 ? String(files.length) : '—' },
  ];
  if (data.reviewSummary) {
    fields.push({ label: 'Reviews', value: text(data.reviewSummary) });
  }
  if (data.checksSummary) {
    fields.push({ label: 'Checks', value: text(data.checksSummary) });
  }
  if (data.url) {
    fields.push({ label: 'URL', value: text(data.url), mono: true, block: true });
  }

  return {
    id,
    kind: 'pull-request-detail',
    title: `PR #${text(data.number)} · ${text(data.title)}`,
    subtitle: `${text(data.branch)} → ${baseOf(data)}`,
    status: data.state === 'open' ? 'success' : 'neutral',
    fields,
    body: typeof data.body === 'string' ? data.body : undefined,
    lines: files.length > 0 ? files : undefined,
    code: typeof data.diff === 'string' ? data.diff : undefined,
    raw: data,
  };
}

/** A commit that was pushed, with the diff it produced. */
function pushCommitCard(id: string, data: Record<string, unknown>): Artifact {
  // The server returns the commit, the pull request it belongs to, the
  // files it changed and the updated diff.
  const commit = isRecord(data.commit) ? data.commit : {};
  const pullRequest = isRecord(data.pullRequest) ? data.pullRequest : null;
  const commitFiles = Array.isArray(commit.files)
    ? (commit.files as string[])
    : [];
  const files = Array.isArray(data.files)
    ? (data.files as string[])
    : commitFiles;

  const path =
    typeof data.path === 'string'
      ? data.path
      : typeof data.file === 'string'
        ? data.file
        : '';

  const fields: ArtifactField[] = [
    { label: 'Commit', value: text(commit.sha ?? data.sha), mono: true },
    {
      label: 'File',
      value: path || commitFiles[0] || files[0] || '—',
      mono: true,
    },
  ];
  if (pullRequest?.number) {
    fields.push({
      label: 'Pull request',
      value: `#${text(pullRequest.number)}`,
      mono: true,
    });
  }
  if (commit.branch ?? data.branch) {
    fields.push({
      label: 'Branch',
      value: text(commit.branch ?? data.branch),
      mono: true,
    });
  }

  return {
    id,
    kind: 'commit-pushed',
    title: `Pushed ${text(commit.sha ?? data.sha)}`,
    subtitle: text(commit.message ?? data.message) || undefined,
    status: 'success',
    fields,
    lines: files.length > 0 ? files : undefined,
    code:
      typeof data.diff === 'string'
        ? data.diff
        : typeof commit.diff === 'string'
          ? commit.diff
          : undefined,
    raw: data,
  };
}

/** The badge of a review: the state, in words and in colour. */
function reviewBadge(state: string): ArtifactRow['badge'] {
  switch (state) {
    case 'approved':
      return { label: 'approved', tone: 'success' };
    case 'changes_requested':
    case 'changes requested':
      return { label: 'changes requested', tone: 'failed' };
    case 'commented':
      return { label: 'commented', tone: 'neutral' };
    case 'dismissed':
      return { label: 'dismissed', tone: 'neutral' };
    default:
      return { label: state || 'unknown', tone: 'neutral' };
  }
}

/** Every review on a pull request, one row each. */
function reviewListCard(
  id: string,
  data: Record<string, unknown>,
): Artifact | null {
  const reviews = Array.isArray(data.reviews) ? data.reviews : null;
  if (!reviews) return null;
  const changes = reviews.filter(
    (review) =>
      isRecord(review) &&
      (review.state === 'changes_requested' ||
        review.state === 'changes requested'),
  ).length;

  return {
    id,
    kind: 'review-list',
    title: 'Reviews',
    subtitle:
      changes > 0
        ? `${reviews.length} review${reviews.length === 1 ? '' : 's'} · ${changes} asked for changes`
        : `${reviews.length} review${reviews.length === 1 ? '' : 's'}`,
    status: changes > 0 ? 'failed' : 'success',
    fields: [],
    rows: reviews.map((review): ArtifactRow => {
      if (!isRecord(review)) {
        return { title: text(review) };
      }
      const state = text(review.state);
      return {
        title: text(review.reviewer ?? review.user ?? review.author),
        meta: text(review.when ?? review.createdAt ?? review.submittedAt),
        badge: reviewBadge(state),
        body: typeof review.body === 'string' ? review.body : undefined,
      };
    }),
    raw: data,
  };
}

/** Every review comment on a pull request, one row each. */
function reviewCommentListCard(
  id: string,
  data: Record<string, unknown>,
): Artifact | null {
  const comments = Array.isArray(data.comments) ? data.comments : null;
  if (!comments) return null;
  const resolved = comments.filter(
    (comment) => isRecord(comment) && comment.resolved === true,
  ).length;

  return {
    id,
    kind: 'review-comment-list',
    title: 'Review comments',
    subtitle: `${comments.length} comment${comments.length === 1 ? '' : 's'} · ${resolved} resolved`,
    status: 'neutral',
    fields: [],
    rows: comments.map((comment): ArtifactRow => {
      if (!isRecord(comment)) {
        return { title: text(comment) };
      }
      const path = pathOf(comment);
      const line = text(comment.line);
      return {
        title: text(comment.author ?? comment.user),
        meta: path ? `${path}${line && line !== '—' ? `:${line}` : ''}` : line,
        badge:
          comment.resolved === true
            ? { label: 'resolved', tone: 'success' }
            : { label: 'open', tone: 'warn' },
        body: typeof comment.body === 'string' ? comment.body : undefined,
      };
    }),
    raw: data,
  };
}

/** The reply the agent left on a review. */
function reviewReplyCard(id: string, data: Record<string, unknown>): Artifact {
  const reply = isRecord(data.reply) ? data.reply : data;
  const commentId = text(reply.commentId);
  const reviewId = text(reply.reviewId);
  const answered = commentId || reviewId;
  const fields: ArtifactField[] = [];
  if (reply.number) {
    fields.push({
      label: 'Pull request',
      value: `#${text(reply.number)}`,
      mono: true,
    });
  }
  if (answered) {
    fields.push({ label: 'Answered', value: answered, mono: true });
  }
  if (reply.author) {
    fields.push({ label: 'Author', value: text(reply.author) });
  }
  if (reply.when ?? reply.createdAt ?? data.when) {
    fields.push({
      label: 'When',
      value: text(reply.when ?? reply.createdAt ?? data.when),
      mono: true,
    });
  }

  // Replying to a review comment resolves it; that is the server's rule.
  const resolved =
    data.resolved === true ||
    reply.resolved === true ||
    Boolean(commentId) ||
    (isRecord(data.comment) && data.comment.resolved === true);

  return {
    id,
    kind: 'review-reply',
    title: 'Replied to the reviewer',
    subtitle: answered ? `on ${answered}` : undefined,
    status: 'success',
    fields,
    body: typeof reply.body === 'string' ? reply.body : undefined,
    rows: resolved
      ? [
          {
            title: 'The comment is resolved',
            badge: { label: 'resolved', tone: 'success' },
          },
        ]
      : undefined,
    raw: data,
  };
}

/** The CI runs for a branch: one row each, with the failure when it failed. */
function workflowRunListCard(
  id: string,
  data: Record<string, unknown>,
): Artifact | null {
  const runs = Array.isArray(data.runs) ? data.runs : null;
  if (!runs) return null;
  const failed = runs.filter(
    (run) => isRecord(run) && (run.status === 'failure' || run.status === 'failed'),
  ).length;

  return {
    id,
    kind: 'workflow-run-list',
    title: 'CI runs',
    subtitle: `${runs.length} run${runs.length === 1 ? '' : 's'}${failed > 0 ? ` · ${failed} failed` : ''}`,
    status: failed > 0 ? 'failed' : 'success',
    fields: [],
    rows: runs.map((run): ArtifactRow => {
      if (!isRecord(run)) {
        return { title: text(run) };
      }
      const status = text(run.status);
      const tone: ArtifactRow['badge'] =
        status === 'success'
          ? { label: 'success', tone: 'success' }
          : status === 'failure' || status === 'failed'
            ? { label: 'failure', tone: 'failed' }
            : status === 'running'
              ? { label: 'running', tone: 'warn' }
              : { label: status || 'queued', tone: 'warn' };

      const row: ArtifactRow = {
        title: text(run.name ?? run.workflow),
        meta: [text(run.runId), text(run.branch)].filter(Boolean).join(' · '),
        badge: tone,
      };

      const failedJob =
        typeof run.failedJob === 'string' ? run.failedJob : '';
      const failedStep =
        typeof run.failedStep === 'string' ? run.failedStep : '';
      if (failedJob || failedStep) {
        row.fields = [
          { label: 'Failed job', value: failedJob || '—', mono: true },
          { label: 'Failed step', value: failedStep || '—', mono: true },
        ];
      }
      if (run.error) {
        row.body = text(run.error);
      }
      if (Array.isArray(run.logExcerpt)) {
        row.code = (run.logExcerpt as string[]).join('\n');
      }
      return row;
    }),
    raw: data,
  };
}

/** The recent commits: a compact list. */
function commitListCard(
  id: string,
  data: Record<string, unknown>,
): Artifact | null {
  const commits = Array.isArray(data.commits) ? data.commits : null;
  if (!commits) return null;

  return {
    id,
    kind: 'commit-list',
    title: 'Commits',
    subtitle: `${commits.length} commit${commits.length === 1 ? '' : 's'}`,
    status: 'neutral',
    fields: [],
    rows: commits.map((commit): ArtifactRow => {
      if (!isRecord(commit)) {
        return { title: text(commit) };
      }
      const files = Array.isArray(commit.files)
        ? (commit.files as string[])
        : undefined;
      const meta = [
        text(commit.sha),
        text(commit.author),
        text(commit.when ?? commit.createdAt),
      ]
        .filter(Boolean)
        .join(' · ');
      const row: ArtifactRow = {
        title: text(commit.message),
        meta,
        lines: files,
      };
      if (commit.deploymentId) {
        row.fields = [
          { label: 'Deployment', value: text(commit.deploymentId), mono: true },
        ];
      }
      return row;
    }),
    raw: data,
  };
}
