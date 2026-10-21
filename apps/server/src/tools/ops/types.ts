/**
 * The Ops Copilot domain model.
 *
 * Muca is an ops copilot for solo developers and small teams: it triages a
 * failing deployment or CI run, finds the likely cause, and — only after
 * the user says so — opens a branch and a pull request.
 *
 * Everything in this file is plain data. The adapters in `mock.ts` produce
 * it; a future GitHub/AWS adapter would produce the same shapes.
 */

export type DeploymentStatus =
  | 'success'
  | 'failed'
  | 'in_progress'
  | 'cancelled'
  | 'queued';

export interface Deployment {
  id: string;
  service: string;
  environment: string;
  version: string;
  /** Who triggered the deployment. */
  actor: string;
  status: DeploymentStatus;
  /** ISO timestamp. */
  startedAt: string;
  /** ISO timestamp; null while the deployment is still running. */
  finishedAt: string | null;
  /** Short human summary, e.g. "rolled out to 3/3 replicas". */
  summary: string;
  /** The commit that was deployed. */
  commit: string;
  /** The CI run that gated this deployment, if any. */
  ciRunId: string | null;
  /** Tail of the deployment log. */
  logTail: string[];
}

export type CiJobStatus = 'success' | 'failed' | 'skipped';

export interface CiStep {
  name: string;
  status: CiJobStatus;
  /** Milliseconds the step took. */
  durationMs: number;
  /** The error output, when the step failed. */
  output?: string;
}

export interface CiJob {
  name: string;
  status: CiJobStatus;
  steps: CiStep[];
}

export interface CiFailure {
  runId: string;
  service: string;
  /** The commit the run was testing. */
  commit: string;
  branch: string;
  /** The job that failed. */
  failedJob: string;
  /** The step inside that job that failed. */
  failedStep: string;
  /** The error message, trimmed to something a human can read. */
  error: string;
  /** The log lines around the failure. */
  logExcerpt: string[];
  /** ISO timestamp. */
  startedAt: string;
  jobs: CiJob[];
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  id: string;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  author: string;
  /** ISO timestamp. */
  createdAt: string;
  /** ISO timestamp. */
  updatedAt: string;
  comments: IssueComment[];
}

export interface IssueComment {
  id: string;
  author: string;
  body: string;
  /** ISO timestamp. */
  createdAt: string;
}

export interface Branch {
  name: string;
  /** The branch it was created from. */
  baseBranch: string;
  createdAt: string;
  /** The head commit on the branch. */
  headCommit: string;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  body: string;
  branch: string;
  baseBranch: string;
  state: 'open' | 'merged' | 'closed';
  author: string;
  createdAt: string;
  url: string;
}

export interface Incident {
  id: string;
  title: string;
  summary: string;
  /** The deployment or CI run that triggered it. */
  source: string;
  service: string;
  severity: 'low' | 'medium' | 'high';
  detectedAt: string;
  /** The likely cause, as far as the evidence shows. */
  likelyCause: string;
  /** The next action a human should take. */
  recommendedAction: string;
  /** Evidence pointers (deployment ids, run ids, log lines). */
  evidence: string[];
}

/**
 * The read/write surface a tool needs.
 *
 * A thin interface per service, so a real adapter can be swapped in later
 * without touching the tools. The mock implementation is deterministic:
 * the same inputs always produce the same outputs, so a demo is
 * reproducible.
 */
export interface OpsAdapters {
  deployments: {
    list(service: string, limit: number): Deployment[];
    get(deploymentId: string): Deployment | undefined;
  };
  ci: {
    listFailures(service: string, limit: number): CiFailure[];
    getFailure(runId: string): CiFailure | undefined;
  };
  issues: {
    list(state: IssueState | 'all', limit: number): Issue[];
    create(input: { title: string; body: string; labels: string[] }): Issue;
    comment(issueNumber: number, body: string): Issue | undefined;
  };
  git: {
    createBranch(input: { name: string; baseBranch: string }): Branch;
    listBranches(): Branch[];
    openPullRequest(input: {
      title: string;
      body: string;
      branch: string;
      baseBranch: string;
    }): PullRequest;
  };
}
