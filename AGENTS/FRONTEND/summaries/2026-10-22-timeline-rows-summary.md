# Summary — One row per tool call: fix the approval timeline and add a test suite

**Status:** complete
**Date:** 2026-10-21

## What changed

- `apps/web/lib/api.ts` → the call id of an event is now read as
  `callId ?? id` (`callIdOf`). The server's event union uses two names for
  the same thing — `id` on `tool_call`/`tool_result`, `callId` on
  `confirmation_required`/`approval_decision` — and the parser only read
  `id`, so the two approval event types arrived with an empty id and the
  timeline could not match them to their tool call.
- `apps/web/lib/timeline.ts` → rewritten around one rule: **one tool call
  is one row**. The timeline now keeps a `CallState` per call id and
  decides the row's status in a second pass, after every event has been
  seen:
  - `confirmation_required` *upgrades* the tool-call row into its approval
    row; it never creates a second row;
  - `approval_decision` is recorded, not applied on the spot, because the
    server emits it **before** it asks for confirmation. A `approved:false`
    decision on a run that is still waiting for the user is a *park*, not a
    rejection, so the row stays `blocked` (WAITING);
  - the run's own state decides the rest: still awaiting → `blocked`;
    approved → `success` (`OK`) once the result arrives, `failed` if the
    tool reported an error; declined → `rejected` (DECLINED); no decision
    and no result → `failed`;
  - an `error` event is attributed to the most recent call that has not
    reported a result, so an approved call whose tool blew up reads FAILED;
  - the tool-call row carries its `callId` from the start.
- `apps/web/tests/parse-events.test.ts` → **new**. 11 tests for the event
  parser: every event type with the id field it actually uses (`id` *and*
  `callId`), `callId` winning when both are present, unknown event types
  carried separately, malformed events not thrown on, a non-array payload.
- `apps/web/tests/timeline.test.ts` → **new**. 15 tests for the timeline:
  a parked run produces one step (not two) with the approval state, the
  exact arguments and the confirmation message; a cancelled run resolves
  that same step to declined and leaves no stale step for the next
  attempt; an approved run resolves the same step to `OK` when the result
  arrives, and to `failed` when the tool errors; one row per non
  destructive call; an unknown event type does not break the timeline; and
  the argument formatting.
- `apps/web/vitest.config.ts` → **new**. Node environment, `tests/**/*.test.ts`.
  No DOM library, no component tests: the code under test is pure.
- `apps/web/package.json` → `test` / `test:watch` scripts, and `vitest`
  `^3.2.4` as a **dev** dependency (already hoisted in the workspace by
  the server, so no new install was needed). No new runtime dependency.

Nothing else changed: no layout, colour, typography or copy change, no
change to what the client sends, and no change to the REST contract. The
server was not touched.

## R1 — the two-row defect, before and after

The "before" screenshot is the **real** pre-fix build: the committed
`lib/api.ts` and `lib/timeline.ts` were restored from `HEAD`, rebuilt, and
driven through the same browser flow.

**Before** — one tool call, two rows, and the first one says DECLINED
although the user has not answered yet:

![before](screenshots/r2-before-parked.png)

```
● Create Branch        create_branch   DESTRUCTIVE   declined   ▶ Show arguments (2)
● Approval required    create_branch   DESTRUCTIVE   waiting    [CONSEQUENTIAL … Approve & run / Cancel]
```

**After** — one tool call, one row, waiting:

![after](screenshots/r2-after-parked.png)

```
● Create Branch        create_branch   DESTRUCTIVE   waiting    [CONSEQUENTIAL … Approve & run / Cancel]
```

Cancel resolves that same row:

![cancelled](screenshots/r2-after-cancelled.png)

```
● Create Branch        create_branch   DESTRUCTIVE   declined
```

Approve resolves that same row, and the tool really runs:

![approved](screenshots/r2-after-approved.png)

```
● Create Branch        create_branch   DESTRUCTIVE   ok        "Approved by you. The tool ran."
● Create Branch result create_branch   ok                     Branch fix/verify-approval
```

### The row labels now shown, per situation

| Situation | Rows | Status shown |
|---|---|---|
| Run parks, awaiting the user | **1** | `waiting` (WAITING) + the approval card |
| User cancels | **1** | `declined` (DECLINED) |
| User approves, the tool runs | **1** | `ok` (OK) |
| User approves, the tool errors | **1** | `failed` (FAILED) |
| A non-destructive call | 1 per call | `ok` (OK) / `failed` (FAILED) |

A `DECLINED` row and a `WAITING` row for the same call can no longer
coexist: the decision is applied to the call's own row, and a run that is
still waiting ignores the park decision the server recorded.

## R2 — the test suite

`apps/web` now has a `test` script (`vitest run`) and 26 tests over the
two pure modules that were hardest to get right:

- `tests/parse-events.test.ts` — 11 tests
- `tests/timeline.test.ts` — 15 tests

**Test isolation.** Neither the demo mode (`lib/demo.ts`) nor the MCP
client (`lib/mcp.ts`) is imported by a test. The tests import `lib/api.ts`
and `lib/timeline.ts` only, both of which are side-effect free on import
(`lib/api.ts` only defines functions and types). The event payloads in
the tests are copies of what the server actually sends.

**Root script.** `npm test` at the workspace root still runs only
`@muca/server`; the coordinator has to wire the web workspace in, as the
task said. The web script exists and passes:

```json
"test": "npm run test --workspace @muca/server && npm run test --workspace @adh/web"
```

## Verification

From `/mnt/ee/aprojects/zyrun/adh`:

| Command | Result |
|---|---|
| `npm run typecheck --workspace @adh/web` | pass (clean) |
| `npm run lint --workspace @adh/web` | pass (clean) |
| `npm run build --workspace @adh/web` | pass (`✓ Compiled successfully`, routes `/` and `/_not-found`) |
| `npm test --workspace @adh/web` | pass — 2 files, 26 tests |
| `npm test` (root, server workspace) | pass — 21 files, 250 tests (not my scope, but green) |

**Bundle / source check** (acceptance criterion): no absolute backend URL,
no hardcoded port, no `VITE_*` in the source or in `.next/static`:

```bash
grep -rnE "localhost|127\.0\.0\.1|:(8099|8113|8114|8199)\b|VITE_" apps/web/app apps/web/lib apps/web/tests
grep -rhoE "https?://(localhost|127\.0\.0\.1|[^"']*:[0-9]{2,5})|:(8099|8113|8114|8199)\b" apps/web/.next/static
grep -rl "VITE_" apps/web/.next/static
```

All three return nothing.

**Real browser flow** (headless Chromium against the production entry
point, `PORT=8113 NODE_ENV=production npx tsx src/index.ts`):

- Parked run → **one** row, `waiting`, with the exact arguments
  (`name=fix/verify-approval`, `baseBranch=main`), the `CONSEQUENTIAL`
  label and both buttons.
- Cancel → **one** row, `declined`, and the run-level note "You declined
  that action. Nothing was run."
- A new attempt after a cancel → **one** row, `waiting`. The cancelled
  run keeps its own single `declined` row above it as history; nothing
  stale is carried into the new run.
- Approve → **one** row, `ok` ("Approved by you. The tool ran."), the
  branch was really created over MCP, and the evidence card is unchanged.
- The demo mode still runs end to end (both approvals, the PR outcome).
- Accessibility re-checked: keyboard-only approve still works, the
  disclosure buttons still expose `aria-expanded`, no button is unnamed,
  the heading order is still `h1 → h2 → h3 → h4`, and there are **no page
  errors**.

**The live run used a stub outside the repo**: `/tmp/opencode/mock-openai.mjs`,
a minimal OpenAI-compatible server on `:8199` (the real OpenAI API is not
reachable from this sandbox). The server, the agent loop, the approval
gate and the MCP transport are all the real ones; only the LLM HTTP
endpoint was replaced. The server was started with
`AI_PROVIDER=openai OPENAI_ENDPOINT=http://localhost:8199/v1
OPENAI_API_KEY=mock OPENAI_MODEL=mock` — note the server's provider
gateway now reads `OPENAI_ENDPOINT` (the old `OPENAI_BASE_URL` still
works as a fallback).

## Decisions / trade-offs

- **A parked decision is not a rejection.** The server records
  `approval_decision { approved: false }` *before* it asks for
  confirmation, to say "approval was requested and withheld". Rendering
  that as DECLINED is what produced the second, wrong row. The timeline
  now only calls a decision a rejection when the run is **not** waiting
  for the user — that is the only moment "declined" is true.
- **The status is decided in a second pass.** The events alone cannot
  answer "was this declined?", because the decision arrives before the
  confirmation and the run's own state (`awaitingConfirmation`,
  `pendingCall`) is what disambiguates it. Deciding after the loop keeps
  the rule in one place instead of spreading it over the event handlers.
- **The client keeps its own `id` field.** `AgentEvent` still carries
  `id` for every event; the parser normalises `callId` into it. Nothing
  else in the app has to know about the server's two names.
- **Errors are attributed to the most recent unresolved call.** The
  server's `error` event carries no call id, so the attribution is a
  heuristic. It is only used to turn an approved call into FAILED, and a
  declined call stays DECLINED regardless of the error that follows it.
- **No DOM testing library.** The task asked for the pure modules only,
  and the components are covered by the browser flow above.
- `vitest` is a dev dependency only; it was already hoisted into the
  workspace by the server, so nothing new was installed and no lockfile
  changed.

## Follow-ups / risks

- The root `npm test` script still only runs the server workspace — the
  coordinator has to add `@adh/web` to it.
- The server currently normalises `callId` to `id` in
  `serializeAgentResult`, so the wire format the client sees today is
  `id`. The client now reads **both** names, so it is correct against
  either shape, but the two spellings are still a trap for the next
  person who touches the event union.
- The cancelled run stays visible above the next attempt (it is a
  completed run with its own single `declined` row). If the coordinator
  wants a cancelled run to disappear from the transcript entirely, that
  is a product decision, not a bug fix, and it was out of scope here.
- The screenshots in `AGENTS/FRONTEND/screenshots/` are build artefacts of
  this verification; the originals are in `/tmp/opencode/shots-r2/`.
- Unrelated in-flight work by the BACKEND agent was present in the tree
  (`apps/server/**`, `.env.example`). I did not touch it and did not
  commit anything.
