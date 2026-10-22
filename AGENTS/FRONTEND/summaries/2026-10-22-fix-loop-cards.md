# Summary — Cards for the fix loop: pull request, reviews, CI runs, commits

**Status:** complete
**Date:** 2026-10-22

Seven new tools on the server, seven new cards in the timeline. The
review that asked for a change and the CI run that failed are now legible
at a glance, and the pull request carries its diff.

## What changed

### `apps/web/lib/artifacts.ts`

- **`Artifact` gained two things:**
  - `code?: string` — a monospace block that scrolls sideways and never
    reflows. A diff belongs in its own box, not in the page flow.
  - `rows?: ArtifactRow[]` — a row per thing: a review, a comment, a CI
    run, a commit. A row carries its own badge, because the badge is the
    point.
- **`ArtifactRow`** is `{ title, meta?, badge?: { label, tone }, body?,
  code?, fields?, lines? }`. The badge always carries a **word**
  (`changes requested`, `approved`, `failure`, `resolved`), never only a
  colour.
- **Seven card builders**, all keyed by tool name in `buildSpecificCard`:
  - `get_pull_request` → the pull request: number, title, state, branch →
    base, author, the files it changes, the review and check summaries, the
    URL, the body, and **the diff** in its own scrolling block.
  - `push_commit` → the commit that was pushed: sha, message, the file it
    changed, the pull request it belongs to, the files, and the updated
    diff.
  - `list_pull_request_reviews` → one row per review: the reviewer, the
    state as a labelled badge (`approved` green, `changes requested` red,
    `commented` neutral) and the body. The card is red when a review asked
    for changes.
  - `list_pull_request_comments` → one row per comment: the author, the
    file and line, the body, and `open` (amber) or `resolved` (green).
  - `reply_to_review` → the reply: the pull request, what it answers, who
    wrote it, when, the body, and a **resolved** row when the comment it
    answers is now resolved.
  - `list_workflow_runs` → one row per run: the workflow name, the run id
    and branch, the status as a labelled badge (`success` green,
    `failure` red, `running`/`queued` amber) and, when it failed, the
    failing job, the failing step, the error and the log excerpt.
  - `list_commits` → a compact list: the message, `sha · author · when`,
    the files it touched, and the deployment it produced when there was
    one.

The builders read the **real** server shapes (checked against the running
server, not only the brief): `push_commit` returns
`{ commit, pullRequest, files, diff }`, `reply_to_review` returns the
reply itself (`{ id, number, commentId, author, body, createdAt }`), and
the lists return `{ count, number, reviews | comments | runs | commits }`.
They still read a flat result, so a shape change on the server degrades
to a slightly emptier card rather than a blank one.

### `apps/web/app/components/artifact-card.tsx`

- Renders the new **rows** (a heading, a quiet meta line, a labelled
  badge, a body, small fields, monospace lines, a scrolling code block).
- Renders the new **code block**: `whitespace-pre` inside `overflow-auto`,
  so a diff scrolls sideways inside its own box and never reflows.
- The badge tones reuse the card's existing status palette
  (`good` / `bad` / `warn` / `line`), so there is one visual language.

### `apps/web/tests/artifacts.test.ts` (new)

15 tests over the new cards: the pull request with its diff, the pushed
commit (both the real nested shape and a flat one), the reviews with their
badges, the comments with the file, the line and the resolved state, the
reply, the CI runs with their status badge and their failure, the commits
with their deployment, and the generic fallback for a tool the frontend
does not know.

Nothing else was touched: not the timeline logic, not the socket client,
not the permission card, not the policies screen, not the help panel.

## Verification

From `/mnt/ee/aprojects/zyrun/adh`:

| Command | Result |
|---|---|
| `npm run typecheck --workspace @adh/web` | pass (clean) |
| `npm run lint --workspace @adh/web` | pass (clean) |
| `npm test --workspace @adh/web` | pass — **7 files, 76 tests** (the 55 from before, the 6 markdown tests another agent added in parallel, and 15 new) |
| `npm run build --workspace @adh/web` | pass (`✓ Compiled successfully`) |

**Bundle and source scan**: no absolute URL, no hardcoded port, no
`VITE_*` in `apps/web/app`, `apps/web/lib`, `apps/web/tests` or in
`.next/static`.

### Against the **real** server

The BACKEND agent's seven tools landed while this task was in progress,
so the cards were verified against the real thing, not only against a
mock:

- The real MCP endpoint on `:8111` answers the seven tools
  (`get_pull_request` → PR #700, the two reviews, the three review
  comments, the two CI runs, the commits), and the payloads were read
  straight from the server's tool implementations so the cards match the
  real shapes.
- A **real run** — the real agent, the real tools, the real socket
  (`updates: live, over the socket`) — was driven in a headless browser
  with the prompt *"Read pull request 700, then list its reviews, its
  review comments and the CI runs for that branch."* The timeline shows
  the pull request with its diff, the reviews with the
  **changes requested** badge, the comments with **open** and
  **resolved**, and the CI runs with **failure** and the log excerpt.
  Screenshot: `apps/web/screenshots/20-fix-loop-real-server.png`.

### Against a local mock

`/tmp/opencode/mockws/` (outside the repository): a `ws` server that
speaks the protocol and replays the seeded fix loop, so the whole
sequence could be driven deterministically. That is where the pushed
commit and the review reply were checked, since they are writes the
agent only performs after a human decision.

- 390px: **no horizontal overflow**, and the diff scrolls inside its own
  box (verified in the browser, not by eye).
- Dark and light both render correctly.
- No page errors in any run.

### Screenshots

`apps/web/screenshots/`: `14-fix-loop.png` (the whole loop),
`15-reviews.png`, `16-ci-runs.png`, `17-pushed-commit.png`,
`18-fix-loop-390.png`, `19-fix-loop-light.png`,
`20-fix-loop-real-server.png` (the real run).

## Follow-ups / risks

- **A policy-approved call reads "Approved by you."** The real server asks
  for permission for tools the policy engine then allows, so a *read*
  tool's row shows the approval summary "Approved by you. The tool ran."
  The wording lives in `lib/timeline.ts` (the timeline logic, out of
  scope here) and it is wrong for a policy decision: it should say
  something like "Allowed by policy." Worth a follow-up task.
- The `get_pull_request` card shows the **review summary** and the
  **checks summary** as they arrive from the server (`2 review(s): 1
  changes requested, 1 commented`). They are the server's one-line
  strings, so the card repeats the count the rows already show. If the
  server ever sends them as structured data, the card should render the
  rows only.
- `push_commit` returns the pull request's file list and diff, not the
  commit's own diff; the card shows the diff it was given, which is the
  branch's current diff. Fine for now, worth knowing.

## Out of scope, as agreed

The server, the MCP endpoint, the timeline logic, the socket client, the
permission card, the policies screen and the help panel were not
touched. Nothing was committed.
