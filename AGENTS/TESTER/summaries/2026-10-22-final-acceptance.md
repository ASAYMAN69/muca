# TESTER — Summary — final acceptance, the submitted tree (2026-10-22)

**Full report:** `AGENTS/TEST_REPORTS/2026-10-22-final-acceptance.md`

**Verdict: PASS** — no P0, no P1. One P2 (a stale number in the README) and two P3.
**Tree under test:** `91a2901` (the HEAD at the end of the run).

## The three findings from 2026-10-21 are closed

| Finding | Status | Evidence |
|---|---|---|
| **P1** an approval could authorise the same action twice | **CLOSED** | 8/8 over real HTTP on the committed tree, including the exact replay-while-parked repro that reproduced it (`toolResults: 0`, parks again). The fix retires spent approvals on every request in `apps/server/src/http/api.ts`. |
| **P2** `create_issue` / `comment_on_issue` published as `readOnlyHint: true` | **CLOSED** | A live `tools/list` reports `readOnlyHint: true` for exactly the six read-only tools, `destructiveHint: true` for exactly `create_branch` + `open_pull_request`, and a coherent `idempotentHint`. 10/10 correct. |
| **P3** the flaky timeout test | **CLOSED** | `tests/tasks.test.ts` ran **20 times in a row — 0 failures**. |

## P0 / P1 list

**None.** Nothing in this round blocks submission.

## The rest

- **P2-1** — the README says `npm test # 250 backend + 26 frontend tests`; the suite is now **260** + 26. One word (`README.md:293`).
- **P3-1** — **no `package-lock.json` is committed**, so a judge's install resolves the floating `@aws-sdk/*` and `openai` ranges from the live registry. The install at `91a2901` succeeded first try, but on 2026-10-21 the same clone failed with `ETARGET … @aws-sdk/types@^3.975.0` and succeeded on a retry. Committing the lockfile removes the class of problem.
- **P3-2** — the README's sample boot banner shows a 4 s probe timeout; the budget is now 10 s (`README.md:76`). Cosmetic.

## What else passed

- **Tool-schema fix** — the published provider schema has no `$schema`, no `exclusiveMinimum`/`exclusiveMaximum`, no `additionalProperties`; required stays required, optional stays optional, `enum`/`minLength`/`maxLength`/defaults all survive, and exclusive bounds are translated into `minimum`/`maximum`. The MCP `tools/list` path is unaffected and still describes every tool correctly.
- **Gateway on the committed tree** — 12/12: priority selection, a rejected key skipped and the gateway falling back (`anthropic invalid_key · gemini ok` ⇒ `gemini`), 429 usable / 401 not, parallel probes (819 ms for three 800 ms stubs), `timeout` classification, no key in any URL or response, `POST /ai/probe` → `applied: false`, a no-key boot with `enabled: false`, and the 10 s budget agreeing between `config.ts` and `.env.example`.
- **Frontend** — 26/26 web tests; the browser pass 13/13: a parked call is **one** `WAITING` row with the approval card, Cancel is **one** `DECLINED` row, Approve is **one** `OK` row plus the separate evidence card, and **no `DECLINED` row ever sits next to a `WAITING` row**. The 2026-10-21 regression is fixed.
- **Entry point** — `npm run dev` now serves the frontend, the API and MCP on **one** port (`/` 200, `/api/v1/health` 200, one listening socket). `cp .env.example .env` boots cleanly, and so does a boot with no `.env` at all.
- **Full suite** — 260 backend + 26 frontend tests pass, `typecheck` clean, `lint` clean, `build` succeeds.
- **Fresh clone** — `git clone` → `npm install` → `npm test` (260 + 26) → `npm run build`, all green with no `node_modules`, no `.next` and no `.env`.
- **Live provider** — a real model called `list_deployments` then `get_deployment` and answered from the real data; a real destructive request parked with the exact arguments; the approval ran the tool; a **wrong** approval was refused with nothing run.

**Recommendation:** ship it. Before the deadline, fix the one stale number in the README and, if there is time, commit a `package-lock.json`.
