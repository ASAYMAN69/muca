# Summary — The fix loop: PR reviews, CI runs, commits, and the ability to actually push a fix

**Status:** complete
**Date:** 2026-10-22

---

## What changed

Muca can now read a review, check the CI, push the change the reviewer
asked for, and say whether the pull request is green. The story no longer
stops at "it opened a PR".

### The domain (`src/tools/ops/types.ts`)

Five new types, and the two axes the adapters needed:

| Type | Fields |
|---|---|
| `PullRequestReview` | `id`, `number`, `reviewer`, `state`, `body`, `createdAt` |
| `PullRequestComment` | `id`, `number`, `reviewId?`, `author`, `path`, `line`, `body`, `createdAt`, `resolved` |
| `PullRequestReply` | `id`, `number`, `reviewId?`, `commentId?`, `author`, `body`, `createdAt` |
| `WorkflowRun` | `runId`, `name`, `branch`, `service`, `status`, `conclusion?`, `failedJob?`, `failedStep?`, `error?`, `logExcerpt?`, `startedAt` |
| `Commit` | `sha`, `message`, `author`, `createdAt`, `files`, `deploymentId?` |

`PullRequest` gains `files: string[]`, `diff: string`, `reviewSummary?` and
`checksSummary?`.

`OpsAdapters` gains `pulls` (`get`, `listReviews`, `listComments`,
`reply`), `ci.listRuns` and `git.listCommits` / `git.pushCommit`.

### The mock world (`src/tools/ops/mock.ts`)

The seeded world grew a whole pull request. The existing triage data is
**untouched** — the current demo does not change.

**The seeded pull request, #700** on `fix/checkout-rounding`:

- a **real unified diff** of the seeded checkout bug, and the files it
  changes (`src/checkout/cart.ts`, `src/checkout/pricing.ts`);
- **two reviews**: `priya.raman` with `changes_requested` ("this loads the
  customer twice — it is already on the session") and `sam.okafor` with
  `commented`;
- **three review comments** on specific files and lines, one resolved and
  two not;
- **two workflow runs** for the branch: `run_4901` (`unit-tests`) failed
  at `test/unit-tests` with the log excerpt, and `run_4900` (`lint`) green;
- a **commit list** for the branch, each commit with the files it touched.

The story hangs together: the pull request fixes a rounding bug, and by
accident it loads the customer a second time. The reviewer's change
request is about the second load, so the fix makes `cart.ts` match `main`
again — and the pull request is left with the rounding fix only.

`push_commit` **really changes the branch**: the file's content is
replaced, the commit list grows, the branch's head commit moves, the pull
request's diff and file list are recomputed, and the branch's workflow
runs are re-queued as `queued`.

The diff is not a fixture: it is computed by a small LCS-based unified
diff generator (`src/tools/ops/diff.ts`) from the **file contents of each
branch**, so it changes when the branch changes.

### The tools (`src/tools/ops/index.ts`)

| Tool | Arguments | Writes |
|---|---|---|
| `get_pull_request` | `{ number }` | no |
| `list_pull_request_reviews` | `{ number }` | no |
| `list_pull_request_comments` | `{ number }` | no |
| `list_workflow_runs` | `{ branch?, service?, limit? }` | no |
| `list_commits` | `{ service?, branch?, limit? }` | no |
| `push_commit` | `{ branch, path, content, message, number? }` | **yes** |
| `reply_to_review` | `{ number, reviewId?, commentId?, body }` | **yes** |

`push_commit` and `reply_to_review` are `writes: true` and **not**
`destructive`: the policy engine already asks about every write, and no
new approval semantics were added. The MCP path, the socket, the policy
engine and the approval gate are all unchanged.

A missing id is a **clean error**: `get_pull_request`, the two list tools
and `reply_to_review` throw a `ToolError` with a message that names what
was not found, rather than crashing or returning a misleading empty
result.

### The prompt (`src/ai/prompt.ts`)

One line, and the existing rules are untouched — in particular the rule
that a consequential tool is **called**, never asked about in prose:

> - When a pull request is open, read it before acting: get_pull_request,
>   list_pull_request_reviews, list_pull_request_comments. If the review asked
>   for a change, make the change with push_commit and answer the reviewer
>   with reply_to_review. Check the CI with list_workflow_runs and say whether
>   it is green.

---

## Verification

All commands from `/mnt/ee/aprojects/zyrun/adh`.

### Tests — 359 passing, 32 files (was 342 across 31)

```
$ npm test --workspace @muca/server

 Test Files  32 passed (32)
      Tests  359 passed (359)
```

The 342 existing tests still pass. The new file is
`tests/fix-loop-tools.test.ts` (17 tests):

| What | How it is proved |
|---|---|
| the seeded pull request | the diff, the files, the two reviews, the three comments (one resolved), the review and checks summaries |
| the new tools | the arguments are validated, the result is right, a missing id is a clean `ToolError` |
| `push_commit` | the file content is replaced, the commit list grows, the diff and the file list change, the CI runs are re-queued, the branch's head moves |
| `reply_to_review` | the reply is recorded, the comment is resolved, the other comment is not |
| determinism | the same push produces the same sha |
| the annotations | the five reads do not write, the two writes do, and neither is destructive |

`tests/tool-annotations.test.ts` was **strengthened**: the read-only and
write lists now include the seven new tools, and a new test asserts that
the two lists together are exactly the catalogue — so a tool that is in
neither would fail the suite.

Three existing assertions counted the tools and were updated from 10 to
**17** (`tests/tool-catalogue.test.ts` ×2, `tests/ai-health.test.ts` ×1).

### Typecheck and lint — clean

```
$ npm run typecheck --workspace @muca/server
> tsc --noEmit
(no output)

$ npm run lint --workspace @muca/server
> eslint src
(no output)
```

### The tool catalogue — 17 tools, on every surface

```
MCP tools/list: 17 tools
  echo                         readOnly=true  destructive=false idempotent=true
  list_deployments             readOnly=true  destructive=false idempotent=true
  get_deployment               readOnly=true  destructive=false idempotent=true
  get_ci_failure               readOnly=true  destructive=false idempotent=true
  list_issues                  readOnly=true  destructive=false idempotent=true
  create_issue                 readOnly=false destructive=false idempotent=false
  comment_on_issue             readOnly=false destructive=false idempotent=false
  create_branch                readOnly=false destructive=true  idempotent=false
  open_pull_request            readOnly=false destructive=true  idempotent=false
  get_pull_request             readOnly=true  destructive=false idempotent=true
  list_pull_request_reviews    readOnly=true  destructive=false idempotent=true
  list_pull_request_comments   readOnly=true  destructive=false idempotent=true
  list_workflow_runs           readOnly=true  destructive=false idempotent=true
  list_commits                 readOnly=true  destructive=false idempotent=true
  push_commit                  readOnly=false destructive=false idempotent=false
  reply_to_review              readOnly=false destructive=false idempotent=false
  diagnose_incident            readOnly=true  destructive=false idempotent=true
```

`GET /api/v1/tools` reports the same **17** tools with the same flags.

### The whole loop, driven with a scripted model

The model was scripted (a local stub endpoint) to call, in order:
`get_pull_request` → `list_pull_request_reviews` →
`list_pull_request_comments` → `push_commit` → `get_pull_request` →
`list_workflow_runs`. The transcript:

```
--- 1. get_pull_request({"number":700})
Pull request #700 "Fix the checkout total rounding" is open (fix/checkout-rounding → main), by muca-ops-copilot.
Files: src/checkout/cart.ts, src/checkout/pricing.ts
Reviews: 2 review(s): 1 changes requested, 1 commented
Checks: 2 check(s): 1 failed, 1 passed
Diff:
--- a/src/checkout/cart.ts
+++ b/src/checkout/cart.ts
@@ -1,3 +1,4 @@
+import { loadCustomer } from './customer';
 import { priceCart } from './pricing';

 export interface Cart {
@@ -7,8 +8,8 @@
 }

 export function loadCart(session: Session): Cart {
-  const customer = session.customer;
+  const customer = loadCustomer(session.customerId);
   const lines = session.lines;
   return { id: session.id, customerId: customer.id, lines };
 }

--- a/src/checkout/pricing.ts
+++ b/src/checkout/pricing.ts
@@ -1,6 +1,11 @@
 export function priceCart(
   lines: Array<{ sku: string; quantity: number }>,
 ): number {
-  return lines.reduce((total, line) => total + line.quantity * 100, 0) / 100;
+  // Rounding every line and adding the rounded numbers is what made
+  // 12.50 + 12.50 come out as 25.01.
+  return lines.reduce(
+    (total, line) => total + Math.round(line.quantity * 100) / 100,
+    0,
+  );
 }

--- 2. list_pull_request_reviews({"number":700})
2 review(s) on pull request #700:
priya.raman — changes_requested: This loads the customer twice — it is already on the session. Please use the customer on the session and drop the extra call.
sam.okafor — commented: The rounding fix itself looks right to me. Nice catch.

--- 3. list_pull_request_comments({"number":700})
3 review comment(s) on pull request #700 (2 still open):
src/checkout/cart.ts:10 — priya.raman (open): session.customer is already loaded. This call doubles the customer lookup, and p99 with it.
src/checkout/cart.ts:1 — priya.raman (open): The import is only there for the double load.
src/checkout/pricing.ts:6 — sam.okafor (resolved): This is the actual rounding fix. Good.

--- 4. push_commit({"branch":"fix/checkout-rounding","path":"src/checkout/cart.ts","content":"…the fixed file…","message":"fix(cart): use the customer already on the session","number":700})
Pushed 63e3118 to "fix/checkout-rounding": fix(cart): use the customer already on the session
Changed src/checkout/cart.ts.
Pull request #700 now changes: src/checkout/pricing.ts
Updated diff:
--- a/src/checkout/pricing.ts
+++ b/src/checkout/pricing.ts
@@ -1,6 +1,11 @@
 export function priceCart(
   lines: Array<{ sku: string; quantity: number }>,
 ): number {
-  return lines.reduce((total, line) => total + line.quantity * 100, 0) / 100;
+  // Rounding every line and adding the rounded numbers is what made
+  // 12.50 + 12.50 come out as 25.01.
+  return lines.reduce(
+    (total, line) => total + Math.round(line.quantity * 100) / 100,
+    0,
+  );
 }

--- 5. get_pull_request({"number":700})
Pull request #700 "Fix the checkout total rounding" is open (fix/checkout-rounding → main), by muca-ops-copilot.
Files: src/checkout/pricing.ts
Reviews: 2 review(s): 1 changes requested, 1 commented
Checks: 2 check(s): 0 failed, 0 passed, 2 waiting
Diff:
--- a/src/checkout/pricing.ts
+++ b/src/checkout/pricing.ts
@@ -1,6 +1,11 @@
 export function priceCart(
   lines: Array<{ sku: string; quantity: number }>,
 ): number {
-  return lines.reduce((total, line) => total + line.quantity * 100, 0) / 100;
+  // Rounding every line and adding the rounded numbers is what made
+  // 12.50 + 12.50 come out as 25.01.
+  return lines.reduce(
+    (total, line) => total + Math.round(line.quantity * 100) / 100,
+    0,
+  );
 }

--- 6. list_workflow_runs({"branch":"fix/checkout-rounding"})
2 CI run(s):
run_4901 unit-tests on fix/checkout-rounding: queued
run_4900 lint on fix/checkout-rounding: queued

--- the answer:
The reviewer was right: the cart loader was fetching the customer a second time. I pushed the fix, the pull request now only changes the pricing file, and the CI has been queued again.
```

What the transcript shows, step by step:

- **Step 1** — the pull request is read: the diff is real, the two files
  are named, the review and check summaries are there.
- **Step 2 and 3** — the review and its comments are read: the reviewer
  wants the double load gone, on `src/checkout/cart.ts`.
- **Step 4** — the fix is pushed. The commit has a sha, the file is
  named, and **the pull request's diff and file list have changed**: the
  `cart.ts` hunk is gone and the pull request now changes only
  `src/checkout/pricing.ts`.
- **Step 5** — reading the pull request again confirms it: the file list
  is `src/checkout/pricing.ts` and the checks are now "0 failed, 0
  passed, 2 waiting".
- **Step 6** — the CI runs are `queued`. The fix re-triggered the build.

### How the verification was run

The model was a **local stub endpoint** on `127.0.0.1:8092` that speaks
the chat-completions protocol, so the real agent loop, the real tools and
the real REST surface ran end to end without a key and without the
network. The server was driven through `createApiRouter` directly,
because a second `next dev` cannot run next to the coordinator's on
8099 — the Next.js frontend is not part of this loop.

---

## Requirements → evidence

| Req | Status | Evidence |
|---|---|---|
| **7 new tools** in `ops/index.ts` and the catalogue | ✅ | The catalogue reports 17; the MCP `tools/list` agrees. |
| **The five reads** return what the task says | ✅ | `tests/fix-loop-tools.test.ts`; the transcript's steps 1, 2, 3 and 6. |
| **`push_commit` returns the commit and the updated diff** | ✅ | The transcript's step 4; the tool's `data` carries `commit`, `files` and `diff`. |
| **`reply_to_review` returns the reply** | ✅ | The tool's `data` is the `PullRequestReply`. |
| **`push_commit` and `reply_to_review` are writes** | ✅ | `writes: true`, `destructive: false`. No new approval semantics. |
| **`push_commit` really changes the branch** | ✅ | The file content is replaced, the commit list grows, the diff and the file list change, the CI runs are re-queued, the head commit moves. |
| **`reply_to_review` resolves the comment** | ✅ | The test asserts the comment is resolved and the other one is not. |
| **The adapters gain the four groups** | ✅ | `pulls`, `ci.listRuns`, `git.listCommits`, `git.pushCommit`. |
| **The new types** | ✅ | `PullRequestReview`, `PullRequestComment`, `PullRequestReply`, `WorkflowRun`, `Commit`. |
| **The mock grows and stays deterministic** | ✅ | The seed is fixed; the same push gives the same sha; the existing triage data is untouched. |
| **The prompt tells the model about the new tools** | ✅ | One line added; the existing rules are unchanged. |
| **Each new tool: arguments validated, result right, a missing id is a clean error** | ✅ | `tests/fix-loop-tools.test.ts`. |
| **The new tools appear in `tools/list` with the right annotations** | ✅ | The MCP listing above: the five reads are `readOnly`, the two writes are not. |
| **17 tools in the catalogue, in `tools/list` and in `/api/v1/tools`** | ✅ | The listing above; the three updated assertions. |
| **The 342 existing tests still pass** | ✅ | 359 pass (342 + 17 new). |
| **The MCP endpoint, the transport, the socket, the policy engine and the approval gate are unchanged** | ✅ | None of those files was touched. |
| **The REST contract is unchanged** | ✅ | `GET /api/v1/tools` and `POST /api/v1/chat` keep their shapes; the catalogue gains the tools automatically. |

### Acceptance criteria

- [x] 17 tools in the catalogue, in `tools/list` and in `/api/v1/tools`,
      with correct annotations.
- [x] The seeded pull request has a diff, two reviews, three comments and
      workflow runs.
- [x] `push_commit` changes the branch for real.
- [x] `reply_to_review` replies and resolves.
- [x] The system prompt tells the model about the new tools.
- [x] `npm test --workspace @muca/server` passes (359), typecheck and
      lint are clean.

---

## Decisions / trade-offs

### 1. The diff is computed, not written down — **flagged**

The brief says `push_commit` must really change the branch, and that the
pull request's diff and file list must update. A diff that is a fixed
string cannot do that. So the mock holds the **file contents of each
branch** and computes the diff from them with a small LCS-based unified
diff generator (`src/tools/ops/diff.ts`).

The consequence is that the fix the agent pushes has to restore
`src/checkout/cart.ts` to what `main` has, so the file drops out of the
pull request's file list. That is the story the brief describes — the
reviewer objected to the double load, and the double load was the
accidental part of the pull request.

### 2. `pulls.getByBranch` is one method more than the brief lists — **flagged**

The brief's adapter list has `pulls.get(number)`, `listReviews`,
`listComments` and `reply`. But `push_commit` has to return **the
updated diff of the pull request on that branch**, and there is no way to
find a pull request by branch with those four.

So `pulls` gained one method, `getByBranch(branch)`. It is an addition,
not a change: the four methods the brief names are all there, with the
signatures it gives them. The `push_commit` tool also takes an optional
`number`, so a caller that knows the pull request can be explicit.

### 3. The two new writes are not `destructive`

The brief says "Do not add any new approval semantics — the engine
already handles them." So `push_commit` and `reply_to_review` are
`writes: true` and `destructive: false`, exactly like `create_issue` and
`comment_on_issue`. The policy engine asks about them because it asks
about every write; the MCP path's elicitation gate is not extended, so
the MCP behaviour is unchanged.

### 4. A missing pull request is an error, not an empty list

`list_pull_request_reviews` and `list_pull_request_comments` take a pull
request number. If the number does not exist, "no reviews" would be a
lie — the pull request is not there at all. So both check that the pull
request exists first and throw a `ToolError` that names what was not
found. The list tools that have no id (`list_workflow_runs`,
`list_commits`) return an empty result, as the other list tools do.

### 5. The seeded run's failure is the double load

The failing CI run reports `checkout/cart.spec.ts` failing, which is the
double load. That is not decoration: after the fix, the run is re-queued
rather than green, because a real CI run takes time. The transcript says
"2 waiting", not "green" — the agent is honest about a run that has not
finished.

### 6. The commit list is filtered by service through the deployment

`list_commits` takes a `service`. A commit is tied to a service through
the deployment it produced, so the filter keeps the commits that have a
deployment on that service. The seeded commits on `main` carry the
deployment ids of the seeded deployments.

---

## Follow-ups / risks

### For the coordinator

- **The README's tool list needs the seven new tools** — it is outside
  `apps/server`, so I did not touch it.
- **The MCP endpoint's tool count changed from 10 to 17.** That is what
  the brief asks for, but anything that asserts "ten tools" — a
  screenshot, a test elsewhere, the README — needs updating.
- **`GET /api/v1/tools` now reports 17 tools.** The REST shape is
  unchanged; only the count grew.

### Risks and limitations

- **The mock world is a mock.** There is no real GitHub behind it. The
  adapters are the seam: a real implementation of `OpsAdapters` (or just
  of `pulls`, `ci` and `git`) drops in without touching a tool.
- **The diff generator is not a git diff.** It is a correct unified diff
  for the line-level changes, but it does not do renames, binary files
  or mode changes — the seeded world has none of those.
- **The commit sha is derived from a hash**, not from git. It is stable
  and unique per (branch, path, message, content), which is what the
  demo needs, but it is not a git object id.
- **The workflow runs are re-queued, not re-run.** A real adapter would
  start a new run; the mock flips the status to `queued` and clears the
  failure, which is the honest state of a run that has just been
  triggered.
- **`list_commits` filters by service through the deployment**, so a
  commit that produced no deployment is invisible to a service filter.
  That is the only sensible meaning of "the commits of a service" in
  this domain.

### Not done (out of scope)

- The frontend. It was not touched.
- The MCP endpoint's behaviour, the transport, the socket, the policy
  engine and the approval gate. All unchanged.
- The REST contract. Unchanged.
- A new approval semantic for the two writes. Deliberately not added.
- Nothing was committed or pushed.
