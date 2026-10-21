# Fix the P1 approval replay, the read-only annotations, and a flaky test

> **Before starting:** if this is a fresh session, read `apps/server/AGENT.md`,
> then `AGENTS/BACKEND/README.md`, then this task. The task is
> self-contained; do not infer from the user chat.

**App:** server
**Assigned by:** coordinator
**Date:** 2026-10-21

## Status

The provider gateway and the tool catalogue are committed and accepted — do
not revisit them.

This task has three parts, in priority order: **R1 is a P1 and must be
fixed**; R2 is a P2; R3 is a flaky test that would embarrass us in front of
a judge who runs `npm test`.

---

## R1 — (P1) A spent approval must not be replayable

### The bug

The TESTER round reproduced this on both the committed tree and the
in-flight tree:

| # | Case | Expected | Actual |
|---|------|----------|--------|
| B4a | replay the same approval **after** the run completed | one call only | parks again, 0 tool results — **correct** |
| B4b | replay the same approval **while a later action is parked** | one call only | **the action ran a second time** |

The cause is in `apps/server/src/http/api.ts`, in the block that maintains
the pending-approval registry after a run:

```ts
if (result.pendingCall) {
  deps.pendingApprovals?.add({ /* the new parked call */ });
} else {
  // The run is no longer waiting for anything: clear the parked
  // approvals it consumed.
  for (const callId of approvedCallIds) {
    deps.pendingApprovals?.remove(callId);
  }
}
```

The spent approval is retired **only when the run does not park**. If the
run parks again on a *different* action, the spent approval stays in the
registry. A client that replays that id gets it resolved into a fresh
`ApprovedAction` and the action runs a second time.

The registry is the authority on which call ids the server issued, so a
stale entry there is a standing authorisation.

### The specification

A regression test already exists and **currently fails**:

`apps/server/tests/approval-replay.test.ts`

It is the specification for this task. Make it pass. It asserts:

1. Run 1 parks on `feature/first` → `pendingCall` C1.
2. Run 2 approves C1, but the model asks for `feature/second`, so the run
   parks again → `pendingCall` C2, and **no** tool result.
3. Run 3 replays C1 → the run must **park again** and produce **no** tool
   result. Today it runs the tool, which is the bug.

It also asserts the normal case: an approval that ran its action cannot
authorise a second call.

### Requirements

- **An approval is consumed when it is used.** The moment an id has been
  resolved into an `ApprovedAction` and the run has acted on it, that id
  must no longer resolve to anything.
- The retirement must happen **whatever the run does afterwards** — whether
  it completes, parks on a different action, or errors.
- A **new** parked call (the one the run is now waiting for) must still be
  registered, so the user can approve *that* action next.
- Keep the "one approval, one action" guarantee that the argument-binding
  fix established. Do not weaken it.
- Do **not** change the REST contract: the client still sends
  `approvedCallIds` and gets `pendingCall` back. The web client needs no
  change.
- Think about the case where the **same** id is sent twice in one request.
  It must authorise at most one action.

### Tests

- `apps/server/tests/approval-replay.test.ts` passes.
- Add a test for the "replay while parked" case at the **HTTP** level (the
  file above already is HTTP-level) and a unit-level assertion that the
  registry no longer holds the spent id after the run.

---

## R2 — (P2) `readOnlyHint` must be true only for tools that do not write

### The bug

`apps/server/src/mcp/server.ts` derives the annotation from the
*destructive* flag:

```ts
readOnlyHint: !tool.destructive,
destructiveHint: tool.destructive,
```

But "destructive" (needs approval) and "read-only" (does not write) are
**different axes**. The result is that two write tools are published as
read-only:

| Tool | Writes? | Published `readOnlyHint` | Correct? |
|---|---|---|---|
| `create_issue` | **yes** | `true` | **no** |
| `comment_on_issue` | **yes** | `true` | **no** |
| `create_branch` | yes | `false` | yes |
| `open_pull_request` | yes | `false` | yes |

A protocol client uses `readOnlyHint` to decide whether a call is safe to
make without asking a human. Publishing a write tool as read-only is a
protocol lie, and it is exactly the kind of thing a judge reading the
`tools/list` output checks.

### Requirements

- Introduce the missing axis in the **catalogue**
  (`apps/server/src/tools/catalogue.ts`), which is the single source of
  truth. A tool entry must be able to say "this writes" independently of
  "this is destructive".
- `readOnlyHint` must be `true` only for a tool that does not write.
  The read-only set is `echo`, `list_deployments`, `get_deployment`,
  `get_ci_failure`, `list_issues`, `diagnose_incident`. The write set is
  `create_issue`, `comment_on_issue`, `create_branch`, `open_pull_request`.
- `destructiveHint` must stay exactly as it is: `true` for
  `create_branch` and `open_pull_request` only. **Do not change which
  tools ask for approval.**
- A tool that writes but is not destructive still does **not** need
  approval — that behaviour must not change. The two axes are independent.
- Publish the new axis on the REST side too, additively (a `readOnly`
  field next to the existing `destructive` one). Existing fields keep
  their names and meanings.
- Derive the annotations from the catalogue, not from a second list, so
  the MCP layer and the REST layer cannot drift again.

### Tests

- A test asserting the exact `readOnlyHint` value for **every** tool.
- A test asserting `destructiveHint` is unchanged (exactly two tools).
- A test asserting the REST catalogue and the MCP `tools/list` agree on
  both flags.
- The frontend reads `readOnlyHint` from the MCP session, so no frontend
  change is needed — but say so explicitly in `SUMMARY.md`.

---

## R3 — (P3) Make the task-timeout test deterministic

`apps/server/tests/tasks.test.ts` → *"times out a task that runs for too
long"* fails intermittently under load. The previous agent confirmed it
fails on the baseline commit too, and that the change is not in the
`TaskRunner`.

The cause is a race at the deadline. `TaskRunner.run` computes
`deadline = Date.now() + timeoutMs` and, after each delay, checks
`Date.now() >= deadline`. With a 30 ms timeout the two steps' delays land
right on the boundary, and whether the check trips depends on timer jitter
and clock granularity. Sometimes the task "finishes" just before the
deadline and never times out.

### Requirements

- The behaviour must be **deterministic**, not timing-luck:
  - a task whose work outlasts the timeout **always** times out;
  - a task that finishes before the timeout **never** times out.
- Do not paper over it with a longer timeout or a sleep. The runner must
  not depend on `setTimeout` firing exactly on time. If the runner waited
  out the full remaining budget, the task is expired — that should be
  decided by what was waited, not by reading the clock again.
- Keep `activeTimerCount` accurate: no timer may leak.
- Fix the test so it asserts the behaviour rather than the coincidence.
  A test that runs the case many times in a row and must always time out
  is good; a test that sleeps to avoid the race is not.

### Tests

- The timeout test is **not flaky**: run it repeatedly (in the test, or
  verify by running the file many times) and it must pass every time.
- A task that finishes comfortably before the deadline still completes
  normally, and `onDone` runs.

---

## Constraints

- **Stay inside `apps/server`.** Do not edit `apps/web`; the frontend
  change for the event-shape issue is a separate, parallel task.
- **Do not change the REST chat contract**, the MCP protocol behaviour, or
  the provider gateway.
- **Do not weaken existing tests.** All 229 must still pass.
- **Do not commit or push.**
- No new dependencies. Zod stays `4.6.7`; MCP SDK stays `1.32.1`.
- Keys are never logged, never in a URL, never in an error message.

## Acceptance criteria

- [ ] `apps/server/tests/approval-replay.test.ts` passes.
- [ ] A spent approval cannot be replayed, including while another action
      is parked — proven by a test.
- [ ] The same id sent twice in one request authorises at most one action.
- [ ] `readOnlyHint` is `true` for exactly the six read-only tools and
      `false` for the four that write — proven by a test.
- [ ] `destructiveHint` still marks exactly `create_branch` and
      `open_pull_request`.
- [ ] The task-timeout test is deterministic — proven by running it
      repeatedly.
- [ ] `npm test --workspace @muca/server` passes (229 pre-existing + new).
- [ ] `npm run typecheck --workspace @muca/server` and
      `npm run lint --workspace @muca/server` are clean.

## Verification

```bash
npm test --workspace @muca/server
npm run typecheck --workspace @muca/server
npm run lint --workspace @muca/server
```

For R1, also drive it over real HTTP: park, approve, park on a different
action, then replay the first approval and confirm the response is
`awaitingConfirmation: true` with a `pendingCall` and **no** `tool_result`
event. Paste the request/response pairs into `SUMMARY.md`.

For R2, paste the `tools/list` annotations from a live MCP session so the
`readOnlyHint` values can be read at a glance.

## Out of scope

- The frontend timeline rows (a separate FRONTEND task is running).
- The provider gateway, the catalogue refactor, the approval argument
  binding — all committed and accepted.
- Anything in `AGENTS/FRONTEND/` or `AGENTS/TESTER/`.
