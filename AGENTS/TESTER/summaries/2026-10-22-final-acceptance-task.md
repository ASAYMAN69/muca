# Final acceptance — the tree that will be submitted

> **Before starting:** read `AGENTS/TESTER.md` (scope, report format,
> severity rules), then this task. This is a **read-only** verification:
> report, do not fix.

**Verdict target:** the tree a judge will receive.
**Assigned by:** coordinator
**Date:** 2026-10-22

## Context

You verified the submission on 2026-10-21 and returned **PASS WITH
RISKS**. Since then, three rounds of work landed and were committed:

| Commit | What |
|---|---|
| `2af90d6` | the root `npm run dev` now serves the app on one port; the README was rewritten |
| `5be15cd` | FRONTEND: one row per tool call, and the first frontend test suite (26 tests) |
| `3c1eb6b` | the tool-schema fix, the Gemini model default, the probe budget |
| `53f0bd0` | the root `npm test` now runs both workspaces |
| `1035fb1` | the default Gemini model is `gemini-2.5-flash-lite` |
| `75d1b05` | BACKEND: spent approvals retired, `writes` separated from `destructive`, the flaky timeout fixed |

Your last report is the reference for what was already checked. **Do not
redo that work.** Verify the delta, and re-verify only what the delta
could have broken.

## Scope

### A — The three findings you raised, closed

1. **P1: the replayed approval.** `apps/server/tests/approval-retirement.test.ts`
   is new, and `apps/server/tests/approval-argument-binding.test.ts` is the
   older spec. Verify over **real HTTP**:
   - approve an action, let it run, then replay the same `approvedCallIds`
     ⇒ it must park, with **no** `tool_result`;
   - park on action A, approve A but the model asks for action B ⇒ B must
     park again;
   - the same id sent **twice in one request** ⇒ at most one action runs.
2. **P2: `readOnlyHint`.** A live `tools/list` must report
   `readOnlyHint: true` for exactly `echo`, `list_deployments`,
   `get_deployment`, `get_ci_failure`, `list_issues`, `diagnose_incident`
   and `false` for the other four. `destructiveHint` must still be `true`
   for exactly `create_branch` and `open_pull_request`. Check
   `idempotentHint` too — it was corrected in the same change.
3. **P3: the flaky timeout test.** Run `tests/tasks.test.ts` **at least 20
   times in a row** and report whether it ever fails. It must not.

### B — The tool-schema fix (new code, high risk)

`apps/server/src/ai/json-schema.ts` is new. It rewrites the JSON Schema
Zod emits into a dialect a provider accepts, because the live Gemini API
rejected Zod's `$schema` keyword with HTTP 400 on every tool call.

- The tool catalogue the agent publishes must contain no `$schema`, no
  `exclusiveMinimum`/`exclusiveMaximum`, and no `additionalProperties`.
- The schema must still describe the tools correctly: a required
  argument stays required, an optional one stays optional, `enum` and
  `minLength`/`maxLength` survive, and a defaulted field is still
  described.
- The MCP `tools/list` input schemas are unaffected (that path publishes
  the Zod shape directly) — confirm they still describe the tools
  correctly.

### C — The provider gateway, on the committed tree

Your §G verified the gateway against an uncommitted snapshot. Re-verify it
against the committed tree:

- `AI_PROVIDER=auto` probes the configured endpoints **in parallel** and
  picks the highest priority that answers;
- a rejected key is classified `invalid_key` and is skipped, and the
  gateway falls back to a working provider (this was observed live:
  `anthropic invalid_key · gemini ok` ⇒ `gemini` selected);
- a 429 counts as usable, a 401 does not;
- the probe budget is now **10 s** — confirm the default and that
  `.env.example` agrees with `src/config.ts`;
- `POST /api/v1/ai/probe` re-runs the probes without changing the
  provider;
- with **no** key at all the server boots with `enabled: false` and the
  demo mode still works.

### D — The frontend timeline (new code, new tests)

- The web app now has a test suite: `npm test --workspace @adh/web`
  (26 tests). Run it.
- Drive the real approval flow in a browser: a parked call must show
  **one** row, `WAITING`, with the approval card. Cancel ⇒ one row,
  declined. Approve ⇒ one row, ok. There must never be a `DECLINED` row
  next to a `WAITING` row.
- The artifact cards must still render: a tool result still shows its
  summary and its card.

### E — The entry point and the docs

- `npm run dev` from the workspace root must serve the frontend, the API
  **and** MCP on `8099` — this was broken and is now fixed.
- `npm test` from the root must run both suites.
- `cp .env.example .env` then boot must work (this failed at the old
  HEAD because the example set `AI_PROVIDER=auto` and the schema did not
  accept it).
- The README's claims must match reality: the tool table, the
  configuration table, the test counts, the boot banner, and the
  "Verified against a real provider" section. Spot-check at least five
  claims against the code.

### F — The full suite, one more time

```bash
npm test          # both workspaces
npm run typecheck
npm run lint
npm run build
```

And a **fresh clone** again (`git clone` to a temp directory, no
`node_modules`, no `.next`, no `.env`): `npm install`, `npm test`,
`npm run build`, then boot. The install is slow; the point is that it
works from scratch.

### G — A live provider, if a key is available

A Gemini key is in the local `.env` (gitignored). The free tier allows a
limited number of requests a day on `gemini-2.5-flash-lite`, so **spend it
carefully** — at most a couple of agent turns, and no repeated probing.

If a key is present, drive **one** real turn end to end and report what
happened: the model calls a tool, the tool returns real data, the model
answers from it. Then, if the quota allows, **one** destructive request
that parks for approval, and its approval. Do not burn the quota on
experiments. If no key is present, say so and skip.

## Rules

- **Read-only.** Do not edit `apps/**`, `.env`, or any config. Do not fix
  anything, even trivially.
- Do not write `AGENTS/BACKEND/` or `AGENTS/FRONTEND/`.
- Do not commit or push.
- A stub model server is fine, under `/tmp/opencode/`, and must be
  labelled as a stub in the report.
- Every finding needs severity, what you did, what you expected, what
  happened, and the exact command or URL.

## Deliverables

1. Full report: `AGENTS/TEST_REPORTS/2026-10-22-final-acceptance.md`.
2. Short verdict: `AGENTS/TESTER/SUMMARY.md`.
3. Rename `AGENTS/TESTER/TASK.md` → `AGENTS/TESTER/TASK-COMPLETE.md`.

## Known issues — do not re-report as new

- The Anthropic adapter has **not** been run against a live Anthropic
  endpoint: the key available for testing is a free-tier key that is
  locked to a desktop client and is rejected with HTTP 403 by design.
  The request shape is asserted against Anthropic's documented API in
  `tests/provider-adapters.test.ts`, and the probe path is proven live
  (it reached the endpoint and the 403 was classified correctly). This is
  a known gap, not a new finding.
- Google's free tier is **per model** and returns HTTP 429 when spent.
  A 429 in the middle of a run is an environment limit, not a product
  defect — report it, but do not file it as a bug in the agent.
- The `DECLINED`-next-to-`WAITING` defect is fixed. If you see it again,
  that is a real regression — report it as such.
