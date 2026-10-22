# Summary — P1 fix: bind the HTTP approval to the parked action, not just the tool name

**Status:** complete
**Date:** 2026-10-21

---

## What changed

The bug is fixed. An approval is now a statement about a specific **action**
(a tool **plus** its exact arguments), not a licence to invoke a tool.

### The root cause

The approval was expressed as a *tool name* in three places, and the
arguments were dropped at each step:

| # | Where | What was lost |
|---|---|---|
| 1 | `HttpApprovalGate` matched `approvedToolNames.has(approval.toolName)` | the arguments were never compared |
| 2 | `api.ts` resolved the approved call id to `parked.toolName` | the parked `arguments` were discarded |
| 3 | `Agent.run()` did `preApproved = approved.has(call.id)` | the gate was bypassed entirely |

The `PendingApprovalRegistry` already stored the arguments. They were simply
never consulted.

### The fix

**`src/ai/approval-gate.ts`**

- **New `ApprovedAction` type** — `{ callId, toolName, arguments }`. An
  approval is now an *action*.
- **New `argumentsMatch(a, b)` + `canonicalize(value)`** — a canonical
  comparison: key order does not matter, JSON-equivalent values compare
  equal, and a different value never matches. It is strict about types
  (`"1"` is not `1`), distinguishes arrays from objects, and does not treat
  an array's reordering as equal (order is meaningful in a list).
- **New `ArgumentNormaliser`** — an optional hook that resolves a tool's
  arguments through its Zod schema, so Zod defaults are applied on **both**
  sides before comparing. A call that omits `baseBranch` and a parked call
  that spelled out `baseBranch: "main"` are the same action.
- **`HttpApprovalGate` now matches on tool + arguments.** The approval is
  consumed by the first call it authorises, so one approval can never
  authorise two actions.
- **`HttpApprovalGate`'s constructor changed** from
  `(callIds, toolNames, audit)` to `(approvedActions, audit, normaliser)`.

**`src/http/api.ts`**

- The approved call ids are resolved through the `PendingApprovalRegistry`
  into **parked actions** (tool + arguments), not tool names.
- The gate is given a normaliser built from the `ToolRegistry`, so the
  comparison sees Zod defaults applied on both sides.
- **The registry is the authority.** A call id the server never issued
  resolves to nothing, so a client cannot invent an approval.

**`src/ai/agent.ts`**

- **The `preApproved` fast path is gone.** The gate is now *always*
  consulted for a destructive tool. The agent passes `approvedCallIds` as
  *candidates*; the gate decides.
- The `approval_decision` event is now emitted **before** the run parks, so
  a withheld approval is in the audit trail and in the event stream (the
  spec test requires this event, and it was previously missing on the
  parking path).

### Two further holes found and closed

These were not in the brief. I found them while verifying the fix, and both
are the same class of bug (an approval that authorises more than it should).

**1. A client could invent an approval (R4).**
`Agent.run()` honoured `approvedCallIds` — a **client-supplied** list —
without consulting the gate. The id in a tool call comes from the *model*,
so if the model emitted an id the client had also sent, the destructive tool
ran with no gate check and no argument check at all. The brief says the
registry is the authority; that is now true. Covered by
*"the client cannot invent an approval"* in the new test file.

**2. The model could reuse an approved call id for a different action.**
My first implementation of the fix kept an exact-call-id fast path
(`action.callId === requestId`), on the reasoning that the id identifies the
parked action. **That reasoning is wrong, and the live probe caught it:**
the model is free to reuse a call id it used before, including the id of a
call the user approved. A reused id with different arguments would have run
the different action. The id now only records *which* parked call the
approval came from; **the arguments alone decide**. Covered by *"refuses a
reused call id with different arguments"*.

### The elicitation path is unchanged

The MCP/elicitation flow was already correct and was not touched
behaviourally: the server asks the client *inside* the same tool call, with
that call's arguments, and only runs it if the client accepts. The R5 test
asserts this still holds.

---

## Verification

All commands from `/mnt/ee/aprojects/adh`.

### Tests — 146 passing, 12 files (was 118 across 10)

```
$ npm test --workspace @muca/server

 ✓ tests/agent.test.ts (8 tests)
 ✓ tests/api.test.ts (5 tests)
 ✓ tests/api-routes.test.ts (9 tests)          ← 1 new
 ✓ tests/approval-action-binding.test.ts (24 tests)  ← NEW FILE
 ✓ tests/approval-argument-binding.test.ts (2 tests)  ← the coordinator's spec test
 ✓ tests/approval-gate.test.ts (17 tests)
 ✓ tests/bedrock-provider.test.ts (14 tests)
 ✓ tests/elicitation.test.ts (7 tests)         ← 1 new
 ✓ tests/mcp-protocol.test.ts (8 tests)
 ✓ tests/ops-tools.test.ts (28 tests)
 ✓ tests/run-history.test.ts (14 tests)
 ✓ tests/tasks.test.ts (10 tests)

 Test Files  12 passed (12)
      Tests  146 passed (146)
```

**The coordinator's regression test now passes:**

```
$ npx vitest run --root apps/server tests/approval-argument-binding.test.ts

 ✓ HTTP approval binds to the parked action, not just the tool name
   > does NOT approve a call whose arguments differ from the parked ones
   > DOES approve a call whose arguments match the parked ones

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

### The REST contract is unchanged

`/api/v1/chat` keeps its exact request and response shapes. The only
change is *internal*: the same `approvedCallIds` array now resolves to
argument-bound actions instead of tool names. No new routes, no new
fields, no changed fields. The FRONTEND agent needs to make **no
changes**.

### The live web approval path, driven by hand

The repo's `.env` has a **dummy** OpenAI key, so a real model call returns
a 401 and cannot drive the flow. I drove the **same** `POST /api/v1/chat`
route and the **same** `createApiRouter` wiring with a scripted provider
that asks for `create_branch` — first with one branch, then with a
different one. (This is the fallback the task explicitly allows. It is a
real HTTP request to a real Express server; only the model is scripted.)

**Turn 1 — the model asks to create a branch:**

```json
{
  "awaitingConfirmation": true,
  "pendingCall": {
    "callId": "call_branch",
    "name": "create_branch",
    "arguments": { "name": "fix/checkout-rounding", "baseBranch": "main" },
    "message": "Create branch (name=\"fix/checkout-rounding\", baseBranch=\"main\")"
  },
  "events": ["tool_call", "approval_decision", "confirmation_required"]
}
```

**Turn 2 — the user sends that call id back, but the model now asks for a
different branch (`attacker-controlled`):**

```json
{
  "awaitingConfirmation": true,
  "pendingCall": {
    "callId": "call_branch",
    "name": "create_branch",
    "arguments": { "name": "attacker-controlled", "baseBranch": "main" },
    "message": "Create branch (name=\"attacker-controlled\", baseBranch=\"main\")"
  },
  "events": ["tool_call", "approval_decision", "confirmation_required"],
  "toolRan": false
}
```

The different action was **not** approved, the run **parked again** with the
new arguments, and **no tool ran**. This is exactly the reported bug, now
fixed.

**Turn 3 — the user approves the *new* call id:**

```json
{
  "awaitingConfirmation": false,
  "events": ["tool_call", "approval_decision", "tool_result", "text"],
  "toolRan": true,
  "toolSummary": "Created branch \"attacker-controlled\" from \"main\"."
}
```

The tool now runs — because the user explicitly approved *that* action.

### The web client's existing flow works unchanged

The client sends `pendingCall.callId` in `approvedCallIds`. That is
unchanged and it still works. Verified in three places:

- **Live** — the three turns above are exactly the web client's flow
  (`POST /chat` → park → `POST /chat` with `approvedCallIds: [callId]`).
- **Over real HTTP in the test suite** — *"parks a destructive tool and
  approves it on the next request"* in `api-routes.test.ts` sends the
  `pendingCall.callId` back and the tool runs.
- **Unit level** — *"the web client's Approve flow"* in the new test file
  asserts the same sequence, and asserts that the tool result contains
  `feature/approved` (the branch the user actually saw).

---

## Requirements → evidence

| Req | Status | Evidence |
|---|---|---|
| **R1** — bind to the parked arguments | ✅ | `argumentsMatch` + `ApprovedAction`. Canonical comparison: key order irrelevant, different value never matches. |
| **R2** — one approval, one action | ✅ | The action is spliced out of the list when consumed. Tests: *"cannot authorise a second, different call"*, *"cannot authorise a different action after the first"*. |
| **R3** — different arguments ⇒ park again | ✅ | The existing `pending`/`isPending` deferral is reused. Test: *"parks with the NEW arguments instead of running the tool"*, and the live Turn 2 above. |
| **R4** — the exact-id path | ✅ | The `preApproved` bypass is **removed**. The registry is the authority. Two further holes closed (invented ids, reused ids). |
| **R5** — elicitation carries the arguments | ✅ | Test: *"sends the actual tool arguments in the elicitation request"*. |
| **R6** — the coordinator's test passes | ✅ | `tests/approval-argument-binding.test.ts` — 2 passed. |

### Acceptance criteria

- [x] `npm test --workspace @muca/server` passes — 146, the 118 pre-existing
      ones still green, plus the spec test and 27 new ones.
- [x] `apps/server/tests/approval-argument-binding.test.ts` passes.
- [x] `npm run typecheck --workspace @muca/server` is clean.
- [x] `npm run lint --workspace @muca/server` is clean.
- [x] Different arguments ⇒ not approved, parks again with the new
      arguments — proven by a test *and* by the live probe.
- [x] Identical arguments are approved, including key-order differences and
      a defaulted field spelled out explicitly — proven by a test.
- [x] One approval cannot authorise two different actions — proven by a test.
- [x] The elicitation request carries the actual arguments — proven by a test.
- [x] The web client's existing flow works unchanged — verified live, over
      real HTTP, and at unit level.

---

## Decisions / trade-offs

### 1. The `HttpApprovalGate` constructor changed

`new HttpApprovalGate(callIds, toolNames, audit)` became
`new HttpApprovalGate(approvedActions, audit, normaliser)`.

The brief anticipated this: *"The `approvedToolNames` mechanism is the
thing that is wrong. You will probably replace it with an argument-bound
mechanism rather than patch it. If you do, update the `HttpApprovalGate`
constructor and the `api.ts` call site together, and update
`approval-gate.test.ts` accordingly — do not delete assertions there,
adapt them to the new contract and say what you changed."*

**What changed in `approval-gate.test.ts`** — four tests were adapted, none
deleted, and no assertion was weakened:

| Test | Before | After |
|---|---|---|
| *"approves a call id that is on the approved list"* | `new HttpApprovalGate(['call_1'])` | an approved **action** |
| *"refuses a call id that is not on the approved list"* | `new HttpApprovalGate(['call_other'])` | an approved action with **different arguments** |
| *"approves the next call to a tool that was approved by name"* | tool name | the same action |
| *"consumes a tool-name approval so it cannot authorise twice"* | tool name | the same action |

The other 13 tests in that file are unchanged.

### 2. The spec test's *setup* was updated; its *assertions* are untouched

`tests/approval-argument-binding.test.ts` passed its ids and tool names into
the gate. Under the new contract it passes the parked **action**. Every
assertion — including `expect(first.pendingCall!.arguments).toEqual({ name:
'feature/approved' })` — is byte-identical. The test was written against
the tool-name contract the brief calls wrong, so its setup had to move with
the contract.

### 3. `agent.test.ts` — one test adapted

*"executes a destructive tool once the call id is approved"* relied on the
raw-id fast path. It now builds a gate that knows the approved action. The
assertions are unchanged.

### 4. The normaliser is optional, and the API supplies it

`HttpApprovalGate` works without a normaliser (arguments compared as they
are). `api.ts` supplies one built from the `ToolRegistry`, which is what
makes the defaulted-field case work in production. The unit tests can pass
one explicitly to exercise the same path.

### 5. `ApprovedAction.callId` is kept, but is no longer the authoriser

It records *which* parked call the approval came from, so the audit trail
can point back at the exact thing the user saw. It is deliberately **not**
part of the match, because the model can reuse a call id (see hole 2 above).

### 6. The `approval_decision` event is now emitted on the parking path

Previously the run returned early when it parked, so no `approval_decision`
event was produced. The spec test asserts that event, and the audit trail
is more useful with it. The event is pushed **before** the park, with
`approved: false`.

---

## Follow-ups / risks

### For the coordinator

- **No frontend change is needed.** The REST contract is byte-identical.
  The `approval_decision` event was already declared in
  `apps/web/lib/api.ts`; it is now actually emitted on the parking path,
  which the frontend's timeline renders.
- **One behavioural change the frontend may want to know about:** a
  destructive call with *different* arguments than the one the user saw now
  parks again instead of running. The frontend already renders
  `pendingCall`, so this needs no code change — but the timeline will show
  a second approval prompt, which is the point.

### Risks and limitations

- **The scripted-provider live probe is not a real model run.** The repo's
  `.env` has a dummy OpenAI key, so a real model call 401s. The HTTP
  route, the router wiring, the registry and the gate are all real; only
  the model is scripted. A run against a real key would exercise the same
  code path with real model output.
- **The argument comparison is by value, not by intent.** Two argument sets
  that are *semantically* the same but textually different (for example a
  branch name with different casing) are different actions. That is the
  safe direction: the user is asked again.
- **Zod defaults are the only normalisation.** If a tool ever transformed
  its arguments in a way that is not captured by its schema (for example
  trimming a path), two logically identical calls could fail to match and
  the user would be asked again. That is the safe direction too, and the
  normaliser hook makes it easy to extend.
- **The run history and the pending-approval registry are unchanged** and
  still in-memory / file-backed as before. The registry remains
  process-local, so an approval does not survive a restart — which is
  correct for an approval, but worth remembering.
- **The `ApprovedAction` list is per-request.** The gate is constructed
  fresh for each `/chat` request from the registry, so an approval is
  consumed once and cannot leak across requests.

### Not done (out of scope)

- No change to the tool set, the mock adapters, Tasks, Bedrock or the run
  history.
- No change to the elicitation path's behaviour.
- No change to the REST contract.
- No frontend work.
- The zod version (`4.6.7`) and the MCP SDK version (`1.32.1`) are
  **unchanged**.
- Nothing was committed or pushed.
