# One row per tool call: fix the approval timeline and add a test suite

> **Before starting:** if this is a fresh session, read `apps/web/AGENT.md`,
> then `AGENTS/FRONTEND/README.md`, then this task. The task is self-contained;
> do not infer from the user chat.

**App:** web
**Assigned by:** coordinator
**Date:** 2026-10-21

## Status

The judge-facing product is committed and accepted — the MCP session panel,
the artifact cards, the demo mode and the responsive layout all passed
verification. **Do not redesign anything.**

This task fixes one visible defect in the approval timeline and adds the
missing test suite for the frontend logic.

---

## R1 — The approval timeline shows two rows for one tool call

### What a judge sees

The TESTER drove the real approval flow in a headless browser and found
this on **every first park**:

```
  ● Create Branch   create_branch   DESTRUCTIVE   DECLINED
    ▶ Show arguments (2)
  ● Approval required   create_branch   DESTRUCTIVE   WAITING
    ┌────────────────────────────────────────────┐
    │ CONSEQUENTIAL  Approval required            │
    │ Create branch (name="feature/ui-probe2", …)│
    │ [ Approve & run ]  [ Cancel ]              │
    └────────────────────────────────────────────┘
```

One tool call, two rows. And the first row is labelled **DECLINED** when
the user has not declined anything — they have not answered yet.

### Why it happens

The server's event union uses **two different field names** for the same
thing (`apps/server/src/ai/agent.ts`):

| Event | The call id field |
|---|---|
| `tool_call` | `id` |
| `tool_result` | `id` |
| `confirmation_required` | **`callId`** |
| `approval_decision` | **`callId`** |

The frontend's parser reads `record.id` for **every** event type
(`apps/web/lib/api.ts`, `parseAgentEvent`). So `confirmation_required` and
`approval_decision` arrive with an **empty** id, and the timeline — which
was written to fold a tool call into its approval row by matching ids —
cannot match them:

- the `confirmation_required` event finds no call to fold into, so it
  **pushes a new row** (`apps/web/lib/timeline.ts`);
- the `approval_decision` event (emitted with `approved: false` when a run
  parks) also cannot find its row, so it pushes another one, with status
  `rejected` — which the UI renders as **DECLINED**.

The `tool_call` row is then left behind with no result, and becomes "the
tool did not return a result".

### What to change

**Parse both names.** In `parseAgentEvent`, the call id must be read as
`record.callId ?? record.id` (both are strings; prefer `callId` when
present). That alone restores the fold: the tool-call row is upgraded
into the approval row, and the decision updates it in place.

**Do not change the server.** The REST contract stays as it is — the
frontend reads what the server sends. Do not edit `apps/server`.

**Treat "parked" as pending, not declined.** The server emits
`approval_decision` with `approved: false` when a run parks, to record
that approval was asked for and withheld. That is **not** a user
rejection. The UI must only render it as *declined* when the run is not
awaiting a decision — i.e. when the user actually cancelled.

The rules to end up with:

| Situation | Rows | Status shown |
|---|---|---|
| Run parks, awaiting the user | **one** row | `WAITING`, with the approval card |
| User cancels | **one** row | `DECLINED` (or `CANCELLED`) |
| User approves, the tool runs | **one** row | `OK` |
| User approves, the tool errors | **one** row | `FAILED` |
| A non-destructive call | one row per call | `OK` / `FAILED` |

Never two rows for one tool call, and never a `DECLINED` row next to a
`WAITING` row for the same call.

**Check the "after Cancel" case specifically.** The TESTER found a stale
row there too: after cancelling, the next attempt showed the old
`DECLINED` row above the new `WAITING` row. Cancelling must resolve the
one row; it must not leave a row behind that a later run duplicates.

### Things that must keep working

- The approval card still shows the **exact arguments** the server will
  run, the `CONSEQUENTIAL` label, and both buttons.
- `Approve & run` still sends `approvedCallIds` and the client still
  replaces the run's events with the server's replayed list, so no step
  appears twice after an approval.
- The evidence rows, the artifact cards, the outcome card, the demo mode
  and the MCP panel are untouched.
- Accessibility: the approval controls keep their roles, labels, focus
  behaviour and `aria-expanded` state.

---

## R2 — Give the frontend a test suite

The timeline logic (`lib/timeline.ts`) and the event parsing
(`lib/api.ts`) are the most intricate frontend code, they are pure
TypeScript, and they had a bug that only a browser run could catch. There
is currently **no frontend test at all**.

- Add **vitest** to `apps/web` (dev dependency) and a `test` script
  (`vitest run`).
- Add `npm test` at the workspace root running **both** workspaces
  (the coordinator will wire the root script — you only need the web
  workspace's `test` script to exist and to pass).
- Do **not** add a DOM testing library. The code under test
  (`lib/timeline.ts`, `lib/api.ts`) is pure — test it directly. Do not
  test the React components; that needs a browser and is not required
  here.
- Cover at least:
  - the event parser: `tool_call` / `tool_result` / `confirmation_required`
    / `approval_decision`, each with the id field it actually uses
    (`id` **and** `callId`);
  - an unknown event type is carried separately and does not break the
    timeline;
  - the timeline for a parked run produces **one** step for the call, with
    the approval state, not two;
  - the timeline for an approved run resolves that same step to `OK` when
    the result arrives;
  - the timeline for a cancelled run resolves it to declined, and does not
    leave a stale step behind when a later run parks a new call;
  - the argument formatting in the timeline (the approval card must show
    the exact arguments).

### Test isolation

The demo mode and the MCP client must not be imported by a unit test
without a server. Keep the tested modules free of side effects on import,
or structure the test so the module is imported cleanly.

---

## Constraints

- **Stay inside `apps/web`.** Do not edit `apps/server`; the server has a
  parallel task running right now.
- **Do not change the REST contract** and do not change what the client
  sends. The server sends `callId` on two event types; the client reads
  it. That is the fix.
- **Do not redesign the UI.** No layout, colour, typography or copy
  changes beyond the status labels in R1. The existing look was reviewed
  and accepted.
- **Do not weaken or delete the existing behaviour** the previous round
  delivered.
- **Do not commit or push.**
- Keep the single-port rule: the browser only ever calls relative
  `/api/v1` paths, and no port may be hardcoded.
- No new runtime dependencies. `vitest` is a dev dependency only.

## Acceptance criteria

- [ ] A parked run shows **one** row for the tool call, with a `WAITING`
      status and the approval card.
- [ ] There is never a `DECLINED` row next to a `WAITING` row for the
      same call, on the first park or after a cancel.
- [ ] Cancelling resolves the one row to declined and leaves no stale
      row behind for the next attempt.
- [ ] Approving resolves the same row to `OK`, with no duplicate.
- [ ] The approval card still shows the exact arguments, the
      `CONSEQUENTIAL` label and both buttons, and the buttons are still
      keyboard-operable.
- [ ] `apps/web` has a `test` script and a test suite that covers the
      parser and the timeline, including every case in R2.
- [ ] `npm run typecheck --workspace @adh/web` is clean.
- [ ] `npm run lint --workspace @adh/web` is clean.
- [ ] `npm run build --workspace @adh/web` succeeds.
- [ ] No hardcoded port or foreign origin in the source or the built
      bundle.

## Verification

```bash
npm run typecheck --workspace @adh/web
npm run lint --workspace @adh/web
npm run build --workspace @adh/web
npm test --workspace @adh/web      # after you add the script
```

Then drive the **real** approval flow in a browser and screenshot it. The
previous round used headless Chromium against the production entry point
(the sandbox cannot reach `fonts.googleapis.com`, so `next dev` may fail
on the fonts; the production build is the supported path):

```bash
npm run build --workspace @adh/web
cd apps/server && PORT=8113 NODE_ENV=production npx tsx src/index.ts
```

With no API key, the **demo mode** exercises both approvals without a
model and is the cheapest way to see the timeline. If you drive a live
approval, use a small OpenAI-compatible stub **outside the repo**, under
`/tmp/opencode/`, and say so in `SUMMARY.md`.

Paste the before/after screenshots into `SUMMARY.md` and say which row
labels you now show for each of the five situations in the table above.

## Out of scope

- The server.
- The MCP session panel, the artifact cards, the demo mode's content and
  the responsive layout.
- Any change to the copy, the colour scheme or the layout.
