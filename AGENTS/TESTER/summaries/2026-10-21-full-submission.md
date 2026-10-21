# TESTER — Summary — full submission, pre-deadline (2026-10-21)

**Full report:** `AGENTS/TEST_REPORTS/2026-10-21-full-submission.md`

**Verdict:** PASS WITH RISKS

**Tree under test:** commit `1e8f908` (clean clone at `/tmp/opencode/muca-clean`) + the provider gateway that landed
uncommitted in the working tree during the run (tested separately and labelled as in-flight in the report).

## Top findings

| Sev | Finding | Where |
|-----|---------|-------|
| **P1** | **An approval can authorise the same action twice.** `POST /api/v1/chat` with `approvedCallIds: [<parked id>]` runs the action; if that run parks again on a *different* action, the earlier approval is never retired from the server-side registry, so replaying the same id runs the **same** action a second time. Violates the brief's §B4 ("one approval, one call"). One-line fix in `apps/server/src/http/api.ts` (retire the ids on every request, not only when the run completes). Reproduced on the committed tree **and** on the in-flight tree. | server |
| **P1** | **`npm run dev` does not serve the app.** The root script runs only `next dev -p 8099`; `/api/v1/health` → **404**, the MCP endpoint is absent. The README, `AGENTS/TESTER.md` and both app `AGENT.md` files all promise the Express server. `npm run dev --workspace @muca/server` works (verified: `/` 200, `/api/v1/health` 200, `/api/v1/mcp` on one port). | config |
| P2 | `create_issue` and `comment_on_issue` are published with `readOnlyHint: true` although they write — a host may auto-run them. | server |
| P2 | At HEAD, `cp .env.example .env` → the server **will not boot** (`AI_PROVIDER=auto` is rejected by the committed `config.ts`). Already fixed in the in-flight tree; keep `.env.example` and the gateway in one commit. | config |
| P2 | The timeline shows a stale `DECLINED` row next to the live `WAITING` row — **worse than the known issue**: it is present on every first park, before the user decides anything, and Cancel leaves two `DECLINED` rows. | web |
| P2 | The README still documents seven placeholder note tools and "no real use case yet". | docs |
| P3 | `npm run lint` fails at HEAD (unused `zod` import in `apps/server/src/mcp/tasks.ts`) — fixed in the working tree. | server |
| P3 | The production build needs `fonts.googleapis.com` (first clean-clone build failed, retry succeeded). | web |
| P3 | Malformed tool input returns an `isError` tool result, not a JSON-RPC `error` object (clean, no stack trace). | server |

## What passed

- **MCP (A):** protocol `2025-11-25`, `serverInfo muca-mcp 0.2.0`, `tools` + `tasks` capabilities, 10 tools with correct
  `destructiveHint`, read-only `tools/call`, a real task handle → `tasks/get` → `completed` with a result, elicitation
  accepted/declined/refused (including a client that declares the capability but cannot answer), clean errors for bad
  input, and a correct session lifecycle (400 / 404 / DELETE).
- **Approval gate (B):** park → approve → run; a different action parks again; a fabricated id authorises nothing; a
  consumed approval cannot be replayed after completion; non-destructive tools never prompt; no REST route bypasses the
  gate; a direct MCP `tools/call` without elicitation is refused. Only the replay-while-parked case fails (P1).
- **Single port (C):** one listening socket, no foreign-origin browser requests, no hardcoded port or `localhost`
  request target in the bundle.
- **Fresh clone (D):** `npm install` → pinned SDK `1.32.1` / zod `4.6.7` (the root `overrides` entry works) → 154 tests
  pass → typecheck clean → build succeeds → the app boots with **no** `.env` at all.
- **Secrets (E):** no `.env` in history, no secret-looking string in the tree, `.env` ignored, `.env.example` committed.
- **Frontend (F):** the demo mode completes end to end and is labelled `DEMO — SCRIPTED, NOT A LIVE RUN` while the MCP
  panel shows a real session; the live timeline shows the tool call, the evidence and the approval; Approve runs the tool,
  Cancel does not; keyboard-only works; 390 px light and dark have no overflow.
- **Gateway (G, in-flight tree):** 12/12 — priority selection (anthropic > openai > gemini), 429 usable / 401 not,
  parallel probes (819 ms for three 800 ms stubs), `timeout` classification, no key in any URL or response,
  `POST /api/v1/ai/probe` → `applied: false`, and Gemini's two same-tool calls resolving to their own results.

**Next:** fix the two P1s, then commit the gateway with `.env.example` and the lint fix, and re-run §B and §G against the
committed tree.
