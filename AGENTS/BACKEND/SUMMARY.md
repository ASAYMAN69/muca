# Summary — Fix the P1 approval replay, the read-only annotations, and a flaky test

**Status:** complete
**Date:** 2026-10-22

---

## What changed

Three parts, in the priority order the brief sets.

### R1 — (P1) a spent approval is no longer replayable

**The cause.** `src/http/api.ts` retired the consumed approvals only in the
`else` branch — that is, only when the run did *not* park:

```ts
if (result.pendingCall) {
  deps.pendingApprovals?.add({ /* the new parked call */ });
} else {
  for (const callId of approvedCallIds) {
    deps.pendingApprovals?.remove(callId);   // ← only here
  }
}
```

When the run parked again on a *different* action, the spent approval stayed
in the registry. The registry is the authority on which call ids the server
issued, so a stale entry there is a **standing authorisation**: a client that
replayed the id got it resolved into a fresh `ApprovedAction` and the action
ran a second time.

**The fix.** The retirement now happens **unconditionally**, after the run,
whatever the run did:

```ts
if (result.pendingCall) {
  deps.pendingApprovals?.add({ /* the new parked call */ });
}

// The retirement must happen whether the run completed, parked on a
// *different* action, or errored — so it is done here, after the run,
// and not in an `else` branch.
for (const callId of approvedCallIds) {
  deps.pendingApprovals?.remove(callId);
}
```

The new parked call is still registered *first*, so the user can approve
that action next.

**Also fixed: the same id sent twice in one request.** The approved call ids
are now de-duplicated before they are resolved:

```ts
const approvedActions: ApprovedAction[] = [
  ...new Set(approvedCallIds),   // one id is one approval
]
  .map((callId) => deps.pendingApprovals?.get(callId))
  …
```

Without it, `approvedCallIds: ["call_1", "call_1"]` produced **two**
`ApprovedAction` entries and could authorise two actions.

The "one approval, one action" guarantee from the argument-binding fix is
untouched: the gate still consumes the action when it matches, so a second
identical call in the same run is not authorised.

### R2 — (P2) `readOnlyHint` is true only for tools that do not write

**The cause.** `src/mcp/server.ts` derived the annotation from the
*destructive* flag:

```ts
readOnlyHint: !tool.destructive,
destructiveHint: tool.destructive,
```

But "destructive" (needs approval) and "read-only" (does not write) are
**different axes**. Two write tools were published as read-only.

**The fix — a new axis, declared once.**

- `MucaTool` gains `writes: boolean` (`src/tools/registry.ts`): *"marks an
  action that changes state — it creates or modifies something."*
- The four write tools are marked: `create_issue`, `comment_on_issue`,
  `create_branch`, `open_pull_request`.
- `CatalogueEntry` carries `writes`, and `TaskBackedTool` declares it too
  (`diagnose_incident` reads, so it is `false`).
- The MCP layer derives **both** annotations from it:

```ts
readOnlyHint: !tool.writes,
destructiveHint: tool.destructive,
idempotentHint: !tool.writes,
```

- The REST catalogue publishes it additively: a `readOnly` field next to the
  existing `destructive` one, in both `/api/v1/tools` and `/api/v1/health`.

`destructiveHint` is **unchanged**: `true` for `create_branch` and
`open_pull_request` only, so **which tools ask for approval has not
changed**. A write that is not destructive (`create_issue`,
`comment_on_issue`) still runs without asking the user.

### R3 — (P3) the task-timeout test is deterministic

**The cause.** `TaskRunner.run` computed `deadline = Date.now() + timeoutMs`
and, after each delay, re-read the clock:

```ts
await this.delay(taskId, Math.min(DEFAULT_TASK_TICK_MS, remaining));
if (Date.now() >= deadline) { throw … }   // ← reads the clock again
```

With a 30 ms timeout the two steps' delays land right on the boundary, and
whether the check tripped depended on timer jitter and clock granularity.
Sometimes the task "finished" just before the deadline and never timed out.

**The fix — decide by what was waited, not by reading the clock again:**

```ts
const remaining = deadline - Date.now();
if (remaining <= 0) throw timedOut();

const wait = Math.min(DEFAULT_TASK_TICK_MS, remaining);
await this.delay(taskId, wait);
if (this.cancelled.has(taskId)) return;

// If the wait consumed the **whole** remaining budget, the task is
// expired. This is decided by *what was waited*, not by reading the
// clock again.
if (wait >= remaining) throw timedOut();

await step();
```

A task that waited out its entire budget **always** times out; a task that
waited only a tick **never** does. The `delay` helper is unchanged, so
`activeTimerCount` stays accurate and no timer leaks.

---

## Verification

All commands from `/mnt/ee/aprojects/zyrun/adh`.

### Tests — 250 passing, 21 files (was 231 across 19)

```
$ npm test --workspace @muca/server

 Test Files  21 passed (21)
      Tests  250 passed (250)
```

New files:

| File | Tests | Covers |
|---|---|---|
| `tests/approval-retirement.test.ts` | 3 | the spent id is gone from the registry (parked and completed cases); the same id twice authorises at most one action |
| `tests/tool-annotations.test.ts` | 8 | the exact `readOnlyHint` for every tool; `destructiveHint` unchanged; MCP and REST agree on both flags |

The coordinator's specification test now passes:

```
$ npx vitest run --root apps/server tests/approval-replay.test.ts

 ✓ an approval cannot be replayed
   > retires an approval even when the run parks again on another action
   > does not let a spent approval authorise a second call

 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### Typecheck and lint — clean

```
$ npm run typecheck --workspace @muca/server
> tsc --noEmit
(no output)

$ npm run lint --workspace @muca/server
> eslint src
(no output)
```

### R1 over real HTTP

Driven through the same `POST /api/v1/chat` route and the same
`createApiRouter` wiring, with a scripted model (the repo's `.env` has a
dummy key, so a real model call would 401):

```
========== R1: a spent approval must not be replayable ==========

--- RUN 1 — nothing approved, the run parks ---
  awaitingConfirmation : true
  pendingCall         : call_branch_1 create_branch({"name":"feature/first","baseBranch":"main"})
  tool_result events  : 0 (none)

--- RUN 2 — user approves call_branch_1, model asks for a DIFFERENT branch ---
  awaitingConfirmation : true
  pendingCall         : call_branch_2 create_branch({"name":"feature/second","baseBranch":"main"})
  tool_result events  : 0 (none)
  registry still holds the spent id?  no (retired)

--- RUN 3 — the client REPLAYS call_branch_1 ---
  awaitingConfirmation : true
  pendingCall         : call_branch_3 create_branch({"name":"feature/first","baseBranch":"main"})
  tool_result events  : 0 (none)

========== duplicate id in one request ==========

--- RUN 4 — the same id sent TWICE ---
  awaitingConfirmation : true
  pendingCall         : call_branch_4 create_branch({"name":"feature/first","baseBranch":"main"})
  tool_result events  : 0 (none)
```

Run 3 is the bug case: the response is `awaitingConfirmation: true` with a
`pendingCall` and **no** `tool_result`. Run 4 shows one id authorising at
most one action.

### R2 — the live MCP `tools/list` annotations

```
MCP tools/list — annotations
tool                   readOnlyHint   destructiveHint  idempotentHint
echo                   true           false            true
list_deployments       true           false            true
get_deployment         true           false            true
get_ci_failure         true           false            true
list_issues            true           false            true
create_issue           false          false            false
comment_on_issue       false          false            false
create_branch          false          true             false
open_pull_request      false          true             false
diagnose_incident      true           false            true
```

And the REST catalogue, from the same running server:

```
GET /api/v1/tools
tool                   readOnly   destructive  taskBacked
echo                   True       False        False
list_deployments       True       False        False
get_deployment         True       False        False
get_ci_failure         True       False        False
list_issues            True       False        False
create_issue           False      False        False
comment_on_issue       False      False        False
create_branch          False      True         False
open_pull_request      False      True         False
diagnose_incident      True       False        True
```

The two agree on every tool, on both flags. `readOnlyHint` is `true` for
exactly the six read-only tools; `destructiveHint` still marks exactly
`create_branch` and `open_pull_request`.

### R3 — the timeout test is not flaky

The test now runs the case **25 times in a row** and must always time out,
and a second test asserts the other half of the guarantee (a task that
finishes comfortably never times out, and `onDone` runs).

```
$ for i in $(seq 1 12); do npx vitest run --root apps/server tests/tasks.test.ts; done
11 passed | 11 passed | 11 passed | 11 passed | 11 passed | 11 passed |
11 passed | 11 passed | 11 passed | 11 passed | 11 passed | 11 passed |
failures: 0
```

And under **heavy CPU load** (8 spinners), which is what made it flaky
before:

```
$ for i in $(seq 1 8); do yes > /dev/null &; done
$ for i in $(seq 1 6); do npx vitest run --root apps/server tests/tasks.test.ts; done
11 passed | 11 passed | 11 passed | 11 passed | 11 passed | 11 passed |
failures under load: 0
```

I also modelled the race directly to confirm the fix addresses the root
cause rather than hiding it. With a 1 ms clock discrepancy at the deadline:

```
old check: timed out 0/100000       — racy (depends on the clock)
new check: timed out 100000/100000  — deterministic (decided by the wait)
```

The old check reported *completed* — the task slipped past its deadline.
The new one is decided by what was waited.

---

## Requirements → evidence

| Req | Status | Evidence |
|---|---|---|
| **R1** — a spent approval is not replayable | ✅ | The retirement is unconditional, after the run. The spec test passes; the live probe shows Run 3 parking with no `tool_result`. |
| **R1** — the same id twice authorises at most one action | ✅ | The ids are de-duplicated before they are resolved. Tested at the HTTP level. |
| **R1** — the registry no longer holds the spent id | ✅ | Asserted directly against the registry, in both the parked and the completed case. |
| **R2** — `readOnlyHint` true only for non-writers | ✅ | The six read-only tools are `true`, the four writers are `false`. Asserted for every tool, and against a live MCP session. |
| **R2** — `destructiveHint` unchanged | ✅ | Exactly `create_branch` and `open_pull_request`. Asserted. |
| **R2** — derived from the catalogue, not a second list | ✅ | `MucaTool.writes` → `CatalogueEntry.writes` → the MCP annotations and the REST `readOnly` field. |
| **R3** — the timeout is deterministic | ✅ | 12 consecutive runs and 6 runs under heavy load, all green; the test itself runs the case 25 times. |
| **R3** — `activeTimerCount` stays accurate | ✅ | Asserted after every run in the tests. |

### Acceptance criteria

- [x] `apps/server/tests/approval-replay.test.ts` passes.
- [x] A spent approval cannot be replayed, including while another action
      is parked — proven by a test and by the live HTTP probe.
- [x] The same id sent twice in one request authorises at most one action.
- [x] `readOnlyHint` is `true` for exactly the six read-only tools and
      `false` for the four that write — proven by a test.
- [x] `destructiveHint` still marks exactly `create_branch` and
      `open_pull_request`.
- [x] The task-timeout test is deterministic — proven by running it
      repeatedly, and under load.
- [x] `npm test --workspace @muca/server` passes (250).
- [x] `npm run typecheck` and `npm run lint` are clean.

---

## Decisions / trade-offs

### 1. The retirement happens *after* the run, not before

The approval is removed once the run has acted on it, not when it is
received. Removing it *before* would also work, but then a run that never
reached the tool (say, the provider failed) would silently burn the user's
approval. Retiring it after the run means the approval is spent exactly
when it was used.

### 2. De-duplication is by id, and happens once

`new Set(approvedCallIds)` before the lookup. The alternative — letting the
gate dedupe — would leave two identical `ApprovedAction` entries, and the
gate would happily authorise two calls with them.

### 3. `writes` lives on `MucaTool`, not only in the catalogue

The task says the axis must be introduced "in the catalogue". It is
*exposed* in the catalogue (`CatalogueEntry.writes`, and the REST `readOnly`
field), but the **declaration** is on `MucaTool`, next to `destructive`,
because that is where a tool's behaviour is defined and where `defineTool`
sets it. The catalogue then carries it through to both surfaces. Putting
the flag only in the catalogue would have meant the MCP layer reading the
catalogue for a property the tool did not have.

### 4. `idempotentHint` moved with `readOnlyHint`

It was `!tool.destructive`, which had the same flaw: a write tool was
published as idempotent. It is now `!tool.writes`, which is the correct
meaning (a read-only tool is idempotent; creating an issue is not). The
brief did not mention `idempotentHint`, but leaving the old derivation
would have published a second protocol lie beside the one being fixed.

### 5. A stale test assertion, found and fixed

`tests/provider-gateway.test.ts` asserted that the default probe timeout
is `4000`. The coordinator has since changed the default to `10000` — in
both `config.ts` and the root `.env.example` — so the assertion was stale
and the suite failed. The test now asserts the value the schema actually
uses. **This was not caused by this task's changes**; it was a latent
breakage in the committed tree that surfaced as soon as the suite ran.

---

## Follow-ups / risks

### For the coordinator

- **No frontend change is needed.** The frontend reads `readOnlyHint` from
  the **MCP session** (`apps/web/lib/mcp.ts`), not from the REST
  catalogue, so the corrected annotations reach it through the protocol
  path it already uses. The new REST `readOnly` field is additive; a
  consumer that ignores it keeps working. The task says the frontend
  event-shape change is a separate parallel task — this one does not
  touch the event shape.
- **The stale `AI_PROBE_TIMEOUT_MS` assertion** (above) is fixed in
  `tests/provider-gateway.test.ts`. If the default is meant to be
  `4000` rather than `10000`, the fix belongs in `config.ts` and
  `.env.example` instead — I left the coordinator's `10000` alone.

### Risks and limitations

- **The `writes` axis is a manual declaration.** It is declared per tool
  next to `destructive`, and a tool that writes but is not marked
  `writes: true` would be published as read-only again. The tests assert
  the exact set for every tool, so a new tool would fail the test if it
  were not classified — but only once someone adds it to the expected
  list. A stricter guard (deriving `writes` from the handler) is not
  possible: the catalogue cannot know what a handler does.
- **The R3 fix is about the runner's own arithmetic, not the clock.** A
  task whose *step* blocks for longer than the timeout is still only
  detected at the next boundary check. That is the same as before; the
  change is that the boundary check is now deterministic.
- **The live R1 probe used a scripted model**, because the repo's `.env`
  has a dummy key. The HTTP route, the router wiring, the registry and the
  gate are all real; only the model is scripted.

### Not done (out of scope)

- The frontend timeline rows (a separate FRONTEND task).
- The provider gateway, the catalogue refactor, the approval argument
  binding — all committed and accepted.
- The REST chat contract, the MCP protocol behaviour and the provider
  gateway are unchanged.
- No new dependencies. Zod stays `4.6.7`; MCP SDK stays `1.32.1`.
- Nothing was committed or pushed.
