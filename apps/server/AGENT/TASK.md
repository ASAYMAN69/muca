# P1 fix: bind the HTTP approval to the parked action, not just the tool name

> **Before starting:** if this is a fresh session, read `AGENT.md` in
> `apps/server`, then read this task. The task is self-contained; do not
> infer from the user chat.

**App:** server
**Assigned by:** coordinator
**Date:** 2026-10-21

## Status

This is a **follow-up to the task you just completed**. The bulk of that
work is done and is good — Elicitation, Tasks, Bedrock, the Ops Copilot tool
set and the run history all landed, with 118 passing tests. **This task is
one focused fix plus a couple of small hardening items.** Do not redo
anything from the previous task.

## Goal

Make the web approval path bind to the **exact action the user saw**, not
just to the tool name.

## Why / context

The previous task introduced `PendingApprovalRegistry` to solve a real
problem: the model produces a **fresh call id** on every turn, so matching
an approval by call id alone would never approve anything. The registry
remembers which tool a parked call referred to, and the HTTP gate then
approves the **next call to that tool**.

That works, but it is too coarse. The registry stores the parked call's
**arguments** and then throws them away — the approval only remembers the
tool *name*.

### The confirmed bug

A regression test for this already exists in the repo and **currently
fails**:

`apps/server/tests/approval-argument-binding.test.ts`

Reproduced against the live code:

```
USER WAS SHOWN: {"name":"feature/approved"}
DECISION: {"type":"approval_decision","callId":"call_2","name":"create_branch","approved":true,"source":"http"}
RESULT: {"type":"tool_result","id":"call_2","name":"create_branch",
         "result":{"summary":"Created branch \"attacker-controlled\" from \"main\"."}}
```

The user approved `create_branch(name="feature/approved")`. The server
executed `create_branch(name="attacker-controlled")`.

This matters for the submission in two ways:

1. **Safety.** The whole product pitch is "permission-aware". Amazon
   explicitly credits safety with user approval. An approval that authorises
   a *different action* than the one on screen undermines the central
   claim, and it is exactly the kind of thing a judge probing the
   permission model would find.
2. **Correctness.** The approval must be a statement about a specific
   action, not a licence to invoke a tool.

### Why this does NOT affect the MCP/elicitation path

The elicitation path is already correct: the server asks the client
*inside* the same tool call, with that call's arguments, and only runs it
if the client accepts. The `ElicitationApprovalGate` sends
`approval.arguments` in the elicitation description. **Do not change that
behaviour** — but do verify it still holds, and add a test that asserts the
elicitation request carries the actual arguments.

The bug is **only** in the HTTP path, where the model re-asks on a later
turn and the approval is matched by tool name.

## Scope

**In scope — `apps/server` only:**

- `apps/server/src/ai/approval-gate.ts`
- `apps/server/src/store/pending-approvals.ts`
- `apps/server/src/http/api.ts`
- `apps/server/src/ai/agent.ts` — only if the fix genuinely requires it
- `apps/server/tests/**`

**Out of scope:**

- `apps/web/**` — the FRONTEND agent owns that.
- The workspace root.
- The Elicitation path's behaviour (it is already correct).
- The zod or MCP SDK versions.
- The Ops Copilot tool set, Tasks, Bedrock, run history — all done.

## Requirements

### R1 — Bind the approval to the parked arguments

The approval must match the parked call's **arguments**, not only its tool
name.

The matching rule must be **exact**: the arguments of the new call must
equal the arguments of the parked call. Use a **canonical** comparison so
that key order and JSON-equivalent values compare equal, but a *different*
value does not.

- `{"name":"feature/approved","baseBranch":"main"}` must match a parked
  `{"baseBranch":"main","name":"feature/approved"}` — same action.
- `{"name":"attacker-controlled"}` must **not** match a parked
  `{"name":"feature/approved"}` — different action.

Note the tool's Zod schema applies defaults (`baseBranch` defaults to
`main`). The parked arguments are the **parsed** arguments (after defaults
are applied), and the new call's arguments are also parsed before matching.
Compare the parsed values, so a call that omits `baseBranch` and a parked
call that spelled it out are the same action. This matters — verify it
with a test.

### R2 — Keep the "one approval, one action" guarantee

The existing guarantee must survive: **one approval can never authorise two
different actions.**

Today the tool-name approval is *consumed* on first use. The new
argument-bound approval must be consumed the same way, so replaying the
same approved call id twice does not authorise a second, different call.

### R3 — What happens when the arguments do not match

The user approved `create_branch(name="feature/approved")` and the model
now asks for `create_branch(name="other")`. The correct behaviour is:

- the call is **not** approved,
- the run **parks again** with a fresh `pendingCall` showing the *new*
  arguments, so the user can approve the new action explicitly,
- the audit trail records the decision.

Do **not** silently run it, and do **not** report it as an error — it is an
ordinary "this is a different action, please confirm" case. The existing
`pending` / deferral mechanism in `HttpApprovalGate` is the right shape for
this; reuse it.

### R4 — The `approvedCallIds` fast path

`Agent.run()` accepts `approvedCallIds` and honours a call id directly
(`preApproved = approved.has(call.id)`) **without consulting the gate**.

Is that safe? An exact call id match *is* safe — the id came from the
server's own `pendingCall`, so the id identifies that exact parked action.
**Verify this reasoning against the code** and make sure the exact-id path
is only honoured for a call id that was actually parked.

If the exact-id path can be reached with an id the server never issued, fix
it. The `PendingApprovalRegistry` is the authority on which ids were
issued — consult it rather than trusting the client's list.

### R5 — Elicitation regression test

Add a test asserting the elicitation request the client receives carries the
**actual tool arguments** of the call being approved (not just the tool
name). The existing elicitation test file already has the machinery for
this.

### R6 — Make the existing regression test pass

`apps/server/tests/approval-argument-binding.test.ts` is already written and
currently fails. It is the specification for this task. Make it pass.

It asserts both directions:
- different arguments ⇒ **not** approved,
- identical arguments ⇒ approved.

## Constraints

- **Stay inside `apps/server`.** Never edit `apps/web` or the workspace root.
- **Do not commit or push.** The coordinator commits after reviewing your
  summary.
- **Do not change the REST contract.** `/api/v1/chat` keeps its request and
  response shapes. The FRONTEND agent is building against the current
  contract, and the web client already implements the "Approve" flow — it
  sends the `pendingCall.callId` back in `approvedCallIds`. Your fix must
  work with that client unchanged.
- **Do not weaken the existing tests.** All 118 must still pass, plus the
  new ones. The only test expected to change behaviour is
  `approval-argument-binding.test.ts`, which must go from failing to
  passing.
- **One port, one origin.** No new listeners.
- **No hardcoded hosts, ports, credentials.**
- **Zod stays at 4.6.7**, **MCP SDK stays at 1.32.1**.
- **Keep the three layers separate.** The approval logic belongs in
  `src/ai/approval-gate.ts`; the registry in `src/store/`. The agent loop
  must not import the MCP transport.

## Acceptance criteria

- [ ] `npm test --workspace @muca/server` passes: all 118 pre-existing tests
      still green, plus the argument-binding test, plus new tests.
- [ ] `apps/server/tests/approval-argument-binding.test.ts` passes.
- [ ] `npm run typecheck --workspace @muca/server` is clean.
- [ ] `npm run lint --workspace @muca/server` is clean.
- [ ] A call with **different arguments** than the parked one is **not**
      approved, and the run parks again with the new arguments — proven by a
      test.
- [ ] A call with **identical arguments** (including a case where the
      arguments are written in a different order, and a case where a
      defaulted field is spelled out explicitly) **is** approved — proven by
      a test.
- [ ] One approval cannot authorise two different actions — proven by a
      test.
- [ ] The elicitation request carries the actual arguments — proven by a
      test.
- [ ] The web client's existing flow (Approve sends `pendingCall.callId` in
      `approvedCallIds`) works unchanged. Say in `SUMMARY.md` how you
      verified this.

## Verification

From `/mnt/ee/aprojects/zyrun/adh`:

```bash
npm test --workspace @muca/server
npm run typecheck --workspace @muca/server
npm run lint --workspace @muca/server
```

Live check — start the server and drive the web approval path by hand:

```bash
npm run dev --workspace @muca/server
```

1. `POST /api/v1/chat` with a message that makes the model call a
   destructive tool. Note the `pendingCall` and its `arguments`.
2. `POST /api/v1/chat` again with `approvedCallIds: ["<callId>"]` and a
   message that makes the model call the same tool with **different**
   arguments.
3. The response must show `awaitingConfirmation: true` again, with a
   `pendingCall` for the **new** arguments — not a tool result.

Paste the actual request/response pairs into `SUMMARY.md`. If the repo's
`.env` has a dummy OpenAI key the model call will fail with a 401, so
drive this through the `Agent` directly in a test if you cannot use a real
key — but say clearly which you did.

## Out of scope

- Any change to the tool set, the mock adapters, Tasks, Bedrock or the run
  history.
- The elicitation path's behaviour.
- The REST contract.
- Frontend work.
- Deployment, IaC, AWS resources.

## Notes

- The bug is subtle but the fix is small. Most of the work is in the
  comparison logic and in making sure the "different action" case parks
  cleanly rather than erroring.
- `PendingApprovalRegistry` already stores `arguments`. The information is
  there; it is just not consulted when matching.
- `HttpApprovalGate` already has a `pending` / `isPending` deferral
  mechanism. The "different arguments" case should reuse it, not invent a
  new mechanism.
- The `approvedToolNames` mechanism is the thing that is wrong. You will
  probably replace it with an argument-bound mechanism rather than patch
  it. If you do, update the `HttpApprovalGate` constructor and the
  `api.ts` call site together, and update
  `apps/server/tests/approval-gate.test.ts` accordingly — do not delete
  assertions there, adapt them to the new contract and say what you
  changed.
- If you conclude the fix needs a contract change the FRONTEND agent would
  have to make, **stop and report it** rather than changing the contract
  yourself. My expectation is that it does not: the client already sends
  the parked call id, and the server already has the parked arguments.
