# The fix loop: PR reviews, CI runs, commits, and the ability to actually push a fix

> **Before starting:** if this is a fresh session, read `apps/server/AGENT.md`,
> then `AGENTS/BACKEND/README.md`, then `AGENTS/WS_PROTOCOL.md`. The task is
> self-contained; do not infer from the user chat.

**App:** server
**Assigned by:** coordinator
**Date:** 2026-10-22
**Deadline: 60 minutes. Work in the order below and cut from the bottom if
you run out of time.**

## Why

Muca can triage a failure and open a pull request. It cannot then *read the
review*, *check the CI*, or *push the change the reviewer asked for*. So the
story stops at "it opened a PR" — and an agent that opens a PR but never
sees it through is not fixing anything.

This batch closes the loop, on the mock world, so the demo can show the
whole thing: **breakage → diagnosis → issue → branch → PR → review → the
fix is pushed → CI runs → the state of the PR.**

## New tools (7)

All of them go in `apps/server/src/tools/ops/index.ts` and the catalogue,
with the same shape as the existing ones. Schemas are Zod; the MCP SDK
publishes them.

### Read

| Tool | Arguments | Returns |
|---|---|---|
| `get_pull_request` | `{ number: number }` | One pull request: state, title, body, branch, base, author, url, the files it changes, its diff, the review summary, and the CI checks summary |
| `list_pull_request_reviews` | `{ number: number }` | Every review: reviewer, state (`approved` / `changes_requested` / `commented` / `dismissed`), the body, when |
| `list_pull_request_comments` | `{ number: number }` | Every review comment: author, the file and line it is on, the body, when, and whether it is resolved |
| `list_workflow_runs` | `{ branch?: string, service?: string, limit?: number }` | The CI runs for a branch or a service: name, status (`queued`/`running`/`success`/`failure`), the conclusion, the failing job and step when it failed, and the log excerpt |
| `list_commits` | `{ service?: string, branch?: string, limit?: number }` | Recent commits: sha, message, author, when, the files each touched, and the deployment it produced when there was one |

### Write

| Tool | Arguments | Returns |
|---|---|---|
| `push_commit` | `{ branch: string, path: string, content: string, message: string }` | The new commit: sha, message, the file that changed, and the **updated diff** of the pull request on that branch |
| `reply_to_review` | `{ number: number, reviewId?: string, commentId?: string, body: string }` | The reply: which review or comment it answers, the body, when |

- `push_commit` and `reply_to_review` are **writes**: `writes: true`. They
  are asked about by the policy engine like every other write. Do not add
  any new approval semantics — the engine already handles them.
- `push_commit` must **actually change the branch**: the file's content is
  replaced, the commit list grows, the pull request's diff and file list
  update, and any workflow run for that branch is re-queued as `queued`.
  A tool that returns a commit but changes nothing is not acceptable.
- `reply_to_review` adds a reply to the review (or comment) and marks the
  comment resolved when it was a review comment.

## The adapters

`apps/server/src/tools/ops/types.ts` — `OpsAdapters` gains:

```ts
pulls: {
  get(number: number): PullRequest | undefined;
  listReviews(number: number): PullRequestReview[];
  listComments(number: number): PullRequestComment[];
  reply(input: { number: number; reviewId?: string; commentId?: string; body: string }): PullRequestReply | undefined;
};
ci: {
  listFailures(service: string, limit: number): CiFailure[];   // existing
  getFailure(runId: string): CiFailure | undefined;             // existing
  listRuns(input: { branch?: string; service?: string; limit: number }): WorkflowRun[];
};
git: {
  createBranch(...): Branch;          // existing
  listBranches(): Branch[];           // existing
  openPullRequest(...): PullRequest;  // existing
  listCommits(input: { branch?: string; service?: string; limit: number }): Commit[];
  pushCommit(input: { branch: string; path: string; content: string; message: string }): Commit;
};
```

New types: `PullRequestReview`, `PullRequestComment`, `PullRequestReply`,
`WorkflowRun`, `Commit`. A `Commit` has `sha`, `message`, `author`,
`createdAt`, `files: string[]`. A `WorkflowRun` has `runId`, `name`,
`branch`, `status`, `conclusion`, `failedJob?`, `failedStep?`, `error?`,
`logExcerpt?`.

## The mock world

`apps/server/src/tools/ops/mock.ts` must grow to support all of it, and
must be **deterministic** — same ids, same contents, every boot.

- `PullRequest` gains `files: string[]`, `diff: string`, `reviewSummary?`
  and `checksSummary?`.
- Seed **one pull request already open** on a branch, with:
  - a real `diff` (a unified diff of the seeded checkout bug),
  - the files it changes,
  - **two reviews**: one `changes_requested` ("this loads the customer
    twice — it is already on the session") and one `commented`,
  - **three review comments** on specific files and lines, one resolved
    and two not,
  - **workflow runs** for its branch: one `failure` (the failing job and
    step, the log excerpt) and one `success`,
  - a **commit list** for the branch, each with the files it touched.
- `push_commit` must apply to the seeded branch: replace the file content,
  append the commit, update the pull request's diff and file list, and
  re-queue the branch's workflow runs.
- A `reply_to_review` must add a reply and resolve the comment.

Keep the existing mock data intact — the current triage demo must not
change.

## The prompt

`apps/server/src/ai/prompt.ts` — add one line so the model knows the new
tools exist and what they are for. Something like:

> - When a pull request is open, read it before acting: `get_pull_request`,
>   `list_pull_request_reviews`, `list_pull_request_comments`. If the
>   review asked for a change, make the change with `push_commit` and
>   answer the reviewer with `reply_to_review`. Check the CI with
>   `list_workflow_runs` and say whether it is green.

Do not change the existing rules, in particular the rule that a
consequential tool is **called**, never asked about in prose.

## Tests

- Each new tool: the arguments are validated, the result is right, and a
  missing id is a clean error, not a crash.
- `push_commit` really changes the branch: the file content is replaced,
  the commit list grows, the pull request's diff and file list change, and
  the workflow runs are re-queued.
- `reply_to_review` adds a reply and resolves the comment.
- The new tools appear in `tools/list` with the right annotations: the
  five reads are `readOnly`, the two writes are not.
- The catalogue and `GET /api/v1/tools` report **17** tools, and the MCP
  `tools/list` agrees.
- The existing 342 tests still pass.

## Constraints

- **Stay inside `apps/server`.**
- **Do not change the MCP endpoint, the transport, the socket, the policy
  engine, or the approval gate.** New tools go through the existing paths.
- **Do not change the REST contract.** The new tools are MCP tools; the
  REST catalogue gains them automatically.
- **Do not commit or push.**
- Zod `4.6.7`, MCP SDK `1.32.1`. No new dependencies.
- The mock must stay deterministic and credential-free.

## Acceptance criteria

- [ ] 17 tools in the catalogue, in `tools/list` and in `/api/v1/tools`,
      with correct annotations.
- [ ] The seeded pull request has a diff, two reviews, three comments and
      workflow runs.
- [ ] `push_commit` changes the branch for real.
- [ ] `reply_to_review` replies and resolves.
- [ ] The system prompt tells the model about the new tools.
- [ ] `npm test --workspace @muca/server` passes (342 + new).
- [ ] Typecheck and lint are clean.

## Verification

```bash
npm test --workspace @muca/server
npm run typecheck --workspace @muca/server
npm run lint --workspace @muca/server
```

Then, on your own port (**not 8099** — the coordinator is using it),
drive the whole loop with a scripted model and paste the transcript into
`SUMMARY.md`:

```
get_pull_request → list_pull_request_reviews → list_pull_request_comments
→ push_commit → get_pull_request (the diff changed) → list_workflow_runs
```
