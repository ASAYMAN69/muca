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
