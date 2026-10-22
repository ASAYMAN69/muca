# Test Report — Full submission, pre-deadline — 2026-10-21

**Verdict:** PASS WITH RISKS
**Scope:** A (MCP protocol) · B (approval safety) · C (single port) · D (fresh clone) · E (config & secrets) · F (frontend) · G (AI provider gateway) · H (regression suite)
**Environment:** single port (8099 for the shipped entry point; 8091–8098 / 8198 / 8301–8303 were **tester infrastructure** — a stub model provider and local provider stubs — so that the BACKEND agent's own server on 8099 was not disturbed)
**Change under test:**

- Commit `1e8f908` ("gitignore build/ and dist/ at any depth") — HEAD at the start of the run and the tree a judge receives from git.
- `f5077c2` (catalogue alignment + provider-gateway dispatch), `cac8b5d` (this brief, section G), `6b08733`, `fda441c`, `26d568e`, `ed02c23`.
- **Uncommitted work in the working tree** that landed *during* this verification (the provider gateway, `AGENTS/BACKEND/SUMMARY.md`, `TASK-COMPLETE.md`). It is not in git; it was tested separately and clearly labelled below. **It must be re-verified after it is committed.**

> The tree moved twice while I was testing: HEAD advanced from `6b08733` to `1e8f908`, and a BACKEND agent wrote the provider gateway into the working tree between 21:00 and 22:10. Everything in "A–F, H" is verified against the committed tree (`1e8f908`, clean clone at `/tmp/opencode/muca-clean`); section G is verified against the **uncommitted** gateway snapshot.

---

## What changed

- **MCP layer** — Streamable HTTP at `/api/v1/mcp`, SDK `1.32.1` pinned, protocol `2025-11-25`, stateful sessions, `tasks` capability, elicitation-gated destructive tools, a task-backed `diagnose_incident`.
- **REST** — `/api/v1/health`, `/tools`, `/chat`, `/runs`, `/runs/:id`, `/tasks`, `/tasks/:id`; `approvedCallIds` is now resolved through the server-side `PendingApprovalRegistry` into a **parked action** (tool + arguments), compared canonically and consumed once.
- **Tool catalogue** — one declaration (`apps/server/src/tools/catalogue.ts`) feeding both `tools/list` and the REST catalogue; `diagnose_incident` is now in both (the old 9-vs-10 split is **fixed**).
- **Frontend** — timeline instead of a chat transcript, artifact cards, a live MCP handshake panel (real SDK client in the browser), a clearly labelled scripted demo mode.
- **AI gateway (in flight, uncommitted)** — parallel probe of Anthropic / OpenAI / Gemini, priority selection, `POST /api/v1/ai/probe`.

---

## Test cases

### A. Protocol compliance (against the committed tree, live server)

| # | Case | Expected | Actual | Evidence | Verdict |
|---|------|----------|--------|----------|---------|
| A1.1 | `initialize` over Streamable HTTP | protocol `2025-11-25` | `2025-11-25` | `node probe-mcp.mjs` → `{"protocolVersion":"2025-11-25"}` | PASS |
| A1.2 | `serverInfo` | `muca-mcp` + version | `muca-mcp` / `0.2.0` | same run | PASS |
| A1.3 | capabilities | `tools` **and** `tasks` | `{"tools":{"listChanged":true},"tasks":{"list":{},"cancel":{},"requests":{"tools":{"call":{}}}}}` | same run | PASS |
| A2.1 | `tools/list` count | every tool | 10 (`echo, list_deployments, get_deployment, get_ci_failure, list_issues, create_issue, comment_on_issue, create_branch, open_pull_request, diagnose_incident`) | same run | PASS |
| A2.2 | `destructiveHint` | exactly `create_branch`, `open_pull_request` | exactly those two | same run | PASS |
| A2.3 | `readOnlyHint` on the read tools | set on the read tools | set on 8 tools | same run | PASS |
| A2.4 | `readOnlyHint` on the **write** tools | must **not** be `readOnly` | `create_issue` and `comment_on_issue` are published with `readOnlyHint: true` | same run | **FAIL → P2-1** |
| A3 | `tools/call` a read-only tool | well-formed result | `echo` → content `muca-probe muca-probe`, `structuredContent` echoed | same run | PASS |
| A4.1 | `diagnose_incident` advertised as task-backed | `execution.taskSupport` present | `"taskSupport":"optional"` | same run | PASS |
| A4.2 | `diagnose_incident` returns a handle | task handle, fast | `taskCreated`, `taskId=9091998aa0bb…`, status `working` | same run | PASS |
| A4.3 | `tasks/get` reaches a terminal state with a result | `completed` + result | statuses `working → completed`; result text contains `Likely cause` | same run | PASS |
| A5.1 | elicitation, client **declares** the capability, accepts | server asks, tool runs | elicitation message `Create branch (name="probe/accepted-by-user", baseBranch="main")`; result `Created branch "probe/accepted-by-user" from "main".` | same run | PASS |
| A5.2 | elicitation accepted with `confirm:false` | refused | `isError: true`, "The user declined to run create_branch. Nothing was changed." | same run | PASS |
| A5.3 | elicitation declined | refused | same | same run | PASS |
| A5.4 | client does **not** declare elicitation | refused | same | same run | PASS |
| A5.5 | client declares elicitation but has no handler | refused (fail closed) | refused in 47 ms | `probe-elicit-edge.mjs` | PASS |
| A6.1 | unknown tool | clean error, no crash, no stack trace | HTTP 200, `isError` result, `MCP error -32602: Tool does_not_exist not found` | `probe-mcp.mjs` | PASS (see P3-1) |
| A6.2 | wrong argument type | clean error | `MCP error -32602: Input validation error: … expected string, received number at message` | same | PASS (P3-1) |
| A6.3 | missing required argument | clean error | `… expected string, received undefined at message` | same | PASS (P3-1) |
| A6.4 | invalid enum value | clean error | `… Invalid option: expected one of "open"\|"closed"\|"all" at state` | same | PASS (P3-1) |
| A7.1 | `POST` without a session id that is not `initialize` | 400 | 400 `Bad Request: no valid session ID provided…` | same | PASS |
| A7.2 | `POST` with an unknown session id | 404 | 404 `Unknown session: does-not-exist` | same | PASS |
| A7.3 | `DELETE` closes the session | 200, then 404 | 200 `{"ok":true}`, then 404 | same | PASS |

### B. Approval safety (live, real HTTP, scripted model)

Driven with a stub OpenAI-compatible provider (`/tmp/opencode/stub-openai.mjs`, outside the repo) so the model is scripted but the HTTP route, the registry and the gate are the product's.

| # | Case | Expected | Actual | Evidence | Verdict |
|---|------|----------|--------|----------|---------|
| B1.1 | destructive request | parked `pendingCall` | `awaitingConfirmation: true`, `pendingCall.arguments = {name:"feature/approved",baseBranch:"main"}` | `probe-approval.mjs` | PASS |
| B1.2 | approve it | the tool runs | `awaitingConfirmation: false`, `tool_result: Created branch "feature/approved" from "main".` | same | PASS |
| B2.1 | approve A, model asks for B (same tool, other args) | **park again**, do not run | `awaitingConfirmation: true`, pending `attacker-controlled`, **0** tool results | same | PASS |
| B2.2 | then approve the new action | that action runs | `Created branch "attacker-controlled" from "main".` | same | PASS |
| B3 | fabricated `approvedCallIds` (`invented-id-never-issued`) | authorises nothing | parked again, 0 tool results | same | PASS |
| B4a | replay the same approval after the run completed | one call only | second request parked again, 0 tool results | same | PASS |
| B4b | **replay the same approval while a later action is parked** | one call only | **the action ran a second time** — `tool_result: Created branch "feature/first" from "main".` | same (reproduced on both the committed tree and the in-flight tree) | **FAIL → P1-1** |
| B5 | non-destructive tool | never asks for approval | events `tool_call, tool_result, text`; no `confirmation_required` | same | PASS |
| B6 | a REST route that bypasses the gate | none | `POST /tools/create_branch`, `/tools/call`, `/chat/tool`, `GET /tools/create_branch/run` → all 404 | same | PASS |
| B7 | direct `tools/call` over MCP without elicitation | refused | refused (A5.4) | `probe-mcp.mjs` | PASS |
| B8 | provider error | error event, not a 500 | `200 {"events":[{"type":"error","message":"Connection error."}]}` | provider pointed at a dead port | PASS |
| B9 | the loop terminates | bounded | 8 rounds → `{"type":"error","message":"Reached the maximum of 8 tool rounds."}` | sticky stub | PASS |

### C. Single port

| # | Case | Expected | Actual | Evidence | Verdict |
|---|------|----------|--------|----------|---------|
| C1.1 | `npm run dev` from the workspace root | `/`, `/api/v1`, `/api/v1/mcp` all on 8099 | **`npm run dev` runs only `next dev -p 8099` (the web workspace). `/api/v1/health` → 404.** | `npm run dev` + `curl -o /dev/null -w '%{http_code}' http://127.0.0.1:8099/api/v1/health` → `404`; Next log `GET /api/v1/health 404` | **FAIL → P1-2** |
| C1.2 | the documented per-app command | everything on one port | `npm run dev --workspace @muca/server` → `/` 200, `/api/v1/health` 200, `/api/v1/mcp` 400 (no session — correct) | `curl` on 8093 | PASS |
| C1.3 | `npm start` after a build, no `.env` | boots, serves everything | booted, `/` 200, `/api/v1/health` 200 | `npm start` on 8095 | PASS |
| C1.4 | the process opens one port | one | `ss -ltnp` shows exactly one listening socket for the app | `ss` output | PASS |
| C2 | the browser calls no foreign origin | none | 0 foreign requests in the live run and in the no-key run | Playwright request log | PASS |
| C3 | the built bundle has no hardcoded port / `localhost` target | none | 0 matches for `:(8099\|8100\|8111\|8112\|8113\|8199)\b`, 0 `VITE_`; the single `localhost` is inside the SDK/undici URL parser (`"localhost"===s.host`), not a request target | `grep -rhoE … apps/web/.next/static` | PASS |

### D. Fresh-clone install (clean clone of `1e8f908`, no `node_modules`, no `.next`, no `.env`)

| # | Case | Expected | Actual | Evidence | Verdict |
|---|------|----------|--------|----------|---------|
| D1 | `npm install` | succeeds, pinned versions | succeeded (509 packages, 4 min). SDK `1.32.1`, zod `4.6.7` (the root `overrides` entry works), next `16.4.2` | `npm install` in `/tmp/opencode/muca-clean` | PASS |
| D2 | `npm test` | green | 13 files / **154 tests passed** | `npm test` | PASS |
| D3 | `npm run typecheck` | clean | clean (both workspaces) | `npm run typecheck` | PASS |
| D4 | `npm run lint` | clean | **1 error**: `apps/server/src/mcp/tasks.ts:1:10 'z' is defined but never used` | `npm run lint` at `1e8f908` | **FAIL → P3-2** |
| D5 | `npm run build` | succeeds | first attempt failed on `next/font/google` (no network to `fonts.googleapis.com`); **the retry succeeded** | build log | PASS with caveat (P3-3) |
| D6 | the app starts with **no** `.env` at all | boots, MCP + API work | booted; `/api/v1/health` → `{"status":"ok","server":{"name":"muca-mcp","version":"0.2.0"},"ai":{"enabled":false,"provider":null},"tools":[…10…]}` | clean clone, no `.env` | PASS |
| D7 | `cp .env.example .env` (the documented step) then boot | boots | **at `1e8f908`: `Failed to start Muca: ZodError: invalid_value … "AI_PROVIDER" … expected one of "openai"\|"bedrock"`** — the committed `.env.example` sets `AI_PROVIDER=auto` but the committed `config.ts` does not accept it. **Fixed in the in-flight tree** (the gateway accepts `auto`). | `cp .env.example .env && node apps/server/dist/index.js` | **FAIL at HEAD → P2-2** |

### E. Configuration and secrets

| # | Case | Expected | Actual | Evidence | Verdict |
|---|------|----------|--------|----------|---------|
| E1.1 | no `.env` in history | none | `git log --all -- .env` → empty | git | PASS |
| E1.2 | no secret-looking string in the tree | none | `git grep -nE 'sk-[A-Za-z0-9_-]{12,}\|AKIA[0-9A-Z]{16}\|ghp_[A-Za-z0-9]{20,}\|aws_secret_access_key'` → no hits | git | PASS |
| E1.3 | `.env` ignored, `.env.example` committed | yes | `git ls-files` → only `.env.example` | git | PASS |
| E2 | `.env.example` ↔ `src/config.ts` | every variable the code reads is listed | at HEAD: `.env.example` documents `ANTHROPIC_*`/`GEMINI_*`/`OPENAI_ENDPOINT`/`AI_PROBE_TIMEOUT_MS` (not implemented at HEAD) and omits `OPENAI_BASE_URL`/`NODE_ENV`; **the in-flight tree matches** | diff of the two lists | **FAIL at HEAD → P2-2** |
| E3 | no hardcoded credentials/hosts/ports in source | none | only `http://localhost:${PORT}/api/v1/mcp` as the *default* public URL and the boot banner — both server-side and config-driven | `grep -rnE 'https?://(localhost\|127\.0\.0\.1)\|:8099' apps/*/src` | PASS |
| E4 | the API is unauthenticated | flag only | it is (known, documented in the README) | — | known |

### F. Frontend (headless Chromium, Playwright, against the running server)

| # | Case | Expected | Actual | Evidence | Verdict |
|---|------|----------|--------|----------|---------|
| F1.1 | no API key: demo mode | completes, clearly labelled as scripted | banner "The AI provider is not configured"; the run is tagged `DEMO — SCRIPTED, NOT A LIVE RUN`; both approvals advance; the outcome is "Pull request #212 is open against `main`." | `browser-demo.py` (16/17; the 1 "failure" is my assertion looking for the literal word "Outcome" — the heading is uppercased by CSS) | PASS |
| F1.2 | no API key: the MCP panel is still real | real session | `connected`, `2025-11-25`, a live session id + Copy button, the `initialize`/`tools/list` JSON-RPC traffic, the 10 tools | same | PASS |
| F2.1 | provider configured: timeline shows tool call, evidence, approval | yes | approval step with the exact arguments (`name=feature/ui-probe2`, `baseBranch=main`) | `browser-approve.py` | PASS |
| F2.2 | approving runs the tool | yes | the branch result appears as an artifact card (`Branch feature/ui-probe2`) and the row resolves to `OK`; the assistant outcome is rendered | same | PASS |
| F2.3 | cancelling does not run the tool | yes | no result step, no "Created branch", the banner "You declined that action. Nothing was run." | `browser-cancel.py` | PASS |
| F3 | the MCP panel shows id / protocol / traffic | yes | `Connected · 10 tools · 58f18a81…ac6b`, `2025-11-25`, timestamped JSON-RPC | `browser-live.py` | PASS |
| F4 | keyboard-only | composer and the approval buttons are reachable and operable | the composer is reached by Tab (order: Cancel → Previous runs → composer); the focused "Approve & run" activates with Enter and runs the tool | `browser-live.py`, `browser-approve.py` | PASS |
| F5 | 390 px, light and dark | no horizontal overflow | `scrollWidth === clientWidth === 390` in both schemes, with and without a key | both browser scripts | PASS |
| F6 | the known cosmetic `DECLINED`-next-to-`WAITING` issue | — | **worse than described**: the stale `DECLINED` row is already there on the **first** park, before the user has decided anything, and after Cancel there are **two** `DECLINED` rows | DOM: `Create Branch / create_branch / DESTRUCTIVE / DECLINED` immediately followed by `Approval required / … / WAITING` | **FAIL (known) → P2-3** |

### G. AI provider gateway — **in-flight, uncommitted tree** (not in git at the time of writing)

Verified against the working tree as of 22:10 (the BACKEND agent's `SUMMARY.md` was written at that moment). The tree was `tsx src/index.ts` from the working tree, with local provider stubs in `/tmp/opencode/gw-stub.mjs` (outside the repo).

| # | Case | Expected | Actual | Evidence | Verdict |
|---|------|----------|--------|----------|---------|
| G1.1 | `AI_PROVIDER=auto`, **no** keys | boots; `/health` `enabled:false`; every provider `not_configured` | boots; `{"enabled":false,"provider":null,"mode":"auto","probes":[anthropic/openai/gemini → not_configured]}` | `curl /health` on 8088/8091 | PASS |
| G1.2 | a missing Anthropic model must not stop the server | boots | boots; anthropic `not_configured`; the server prints "auto → none — the server will run without a model" | same | PASS (P3-4: the detail says "No API key configured." although a key *was* set) |
| G2.1 | anthropic 200 + openai 200 | anthropic | `wouldSelect: "anthropic"` | `probe-gateway.mjs` | PASS |
| G2.2 | anthropic 401 + openai 200 | openai | `wouldSelect: "openai"` | same | PASS |
| G2.3 | openai 401 + gemini 200 | gemini | `wouldSelect: "gemini"` | same | PASS |
| G2.4 | all fail | nothing selected | `wouldSelect: null` (no silent fallback) | same | PASS |
| G3.1 | a 429 counts as usable | usable | anthropic `status:"throttled", ok:true` | same | PASS |
| G3.2 | a 401 does not | not usable | openai `status:"invalid_key", ok:false` | same | PASS |
| G4 | the three probes run in parallel | ~800 ms, not ~2400 ms | **819 ms** with three 800 ms stubs | same | PASS |
| G5 | a provider that never answers | classified `timeout`, the others unaffected | anthropic `status:"timeout", ok:false` after 4006 ms; openai and gemini `ok` in the same round | same | PASS |
| G6 | no key in a log, a URL or a response | none | no key in `/health` or `/ai/probe`; no key in any probe URL (the stub logged every request URL) | same | PASS |
| G7 | `POST /api/v1/ai/probe` | `applied:false`, provider unchanged | `{"applied":false,…}`; `/health` provider `anthropic` before and after | same | PASS |
| G8 | Gemini: two calls to the same tool in one turn | two distinct results | ids `gemini_call_1_list_deployments` / `gemini_call_2_list_deployments`; results differ (checkout-api vs payments-worker) | `probe-gemini.mjs` | PASS |

### H. Regression suite — exact output

Against the **committed** tree (`1e8f908`, clean clone):

```
$ npm test --workspace @muca/server
 Test Files  13 passed (13)
      Tests  154 passed (154)

$ npm run typecheck
> tsc --noEmit            (server)  — no output
> tsc --noEmit            (web)     — no output

$ npm run lint
/tmp/opencode/muca-clean/apps/server/src/mcp/tasks.ts
  1:10  error  'z' is defined but never used. Allowed unused vars must match /^_/u
✖ 1 problem (1 error, 0 warnings)
npm error Lifecycle script `lint` failed with error: code 1

$ npm run build --workspace @adh/web
✓ Compiled successfully in 33.4s
✓ Generating static pages using 3 workers (3/4)
Route (app)  ○ /   ○ /_not-found
```

Against the **in-flight** working tree (with the gateway, uncommitted):

```
$ npm test
 Test Files  17 passed (17)
      Tests  229 passed (229)

$ npm run lint      → clean
$ npm run typecheck → clean
```

---

## Regressions checked

- The **non-destructive** path of the agent loop (B5), the provider-error path (B8) and the round limit (B9) — all still behave.
- The **REST** surface: `/health` 200, `/tools` 200, `/chat` 200, `/chat` with a bad body → 400 with `details`, `/chat` with no provider → 503, `/runs` 200, `/runs/:unknown` 404, `/tasks` 200, `/tasks/:unknown` 404. No 500s anywhere.
- The **MCP session lifecycle** (400 / 404 / DELETE) and the **task lifecycle** (`tasks/get` → `completed`).
- The **tool catalogue** on all three surfaces — now consistent: `tools/list` 10, `/api/v1/tools` 10, `/api/v1/health` 10, with `diagnose_incident` marked `taskBacked: true`. **The known 9-vs-10 issue is fixed.**
- The **frontend** after the backend changes: the demo mode, the live approval flow, the cancel path, the MCP panel, the 390 px layout and the keyboard path all still work.
- The **approval gate** re-verified against the in-flight tree: B1, B2, B3, B4a, B5, B6 all still pass; B4b still fails (P1-1).

---

## Findings

### P1-1 — An approval can authorise the **same** action twice (approval replay across requests)

- **Repro** (live, against the running server, scripted model):
  1. `POST /api/v1/chat` → the model asks for `create_branch(name="feature/first")` → the run parks, `pendingCall.callId = call_b4b_a`.
  2. `POST /api/v1/chat` with `approvedCallIds: ["call_b4b_a"]`, and the model answers with **two** tool calls: `create_branch(name="feature/first")` **and** `create_branch(name="feature/second")`.
     → the first action is approved and runs; the second one is a *different* action, so the run parks again on it.
  3. `POST /api/v1/chat` with `approvedCallIds: ["call_b4b_a"]` **again** (the same id, replayed), and the model asks for `create_branch(name="feature/first")` once more.
     → **the tool runs a second time**: `tool_result: "Created branch \"feature/first\" from \"main\"."`
- **Expected:** one approval authorises one call only (brief §B4).
- **Actual:** the second, identical action executes on a replayed approval.
- **Suspected area:** server — `apps/server/src/http/api.ts` (the `PendingApprovalRegistry` cleanup).
- **Root cause:** the registry entry is removed only when the run does **not** park again:
  ```ts
  if (result.pendingCall) { deps.pendingApprovals?.add({…}); }
  else { for (const callId of approvedCallIds) deps.pendingApprovals?.remove(callId); }
  ```
  When the run parks on a *later* action, the earlier approval is never retired, so the server-side registry still treats it as live. The `HttpApprovalGate` itself is correct — it consumes an action once per request — but the *registry* re-supplies it on the next request.
- **Blast radius:** the action that can be replayed is the exact action the user saw and approved (same tool, same arguments) — it is not an escalation to a different action. It is reachable by any client that replays an approval id it was given (the API is unauthenticated by design in this build), provided the model re-issues the same action. It is **not** reachable from the shipped web UI, which sends each approval id exactly once.
- **Suggested owner:** BACKEND. Minimal fix: retire every id in `approvedCallIds` on **every** request (not only when the run completes), e.g. remove the ids *before* adding the new parked approval.
- **Also affected:** the same retention means a stale approval can authorise the same action in a later, unrelated run.

### P1-2 — `npm run dev` (the documented quick start) does not serve the API or MCP

- **Repro:**
  ```bash
  cd /mnt/ee/aprojects/adh && npm run dev      # → next dev -p 8099
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8099/api/v1/health   # → 404
  ```
  Next's own log: `GET /api/v1/health 404 in 143ms`.
- **Expected:** the root `npm run dev` starts the Express server that hosts the app, the API and MCP on 8099 — the README says so, `AGENTS/TESTER.md` says so, and `apps/server/AGENT.md` / `apps/web/AGENT.md` both say to run `npm run dev --workspace @muca/server` ("serves the frontend at :8099").
- **Actual:** the root script is `npm run dev --workspace @adh/web` → `next dev -p 8099`. The API and the MCP endpoint are **not served at all**; the page shows "API unreachable" and the MCP panel's handshake fails. A judge who follows the README sees a broken product.
- **Suspected area:** config — the root `package.json` `dev` script.
- **Suggested owner:** BACKEND (or HEAD). The fix is one line: point the root `dev` script at `@muca/server` (verified working: `npm run dev --workspace @muca/server` serves `/` 200, `/api/v1/health` 200 and `/api/v1/mcp` on one port).
- **Note:** `npm run build && npm start` works and is a fine fallback, but it is not what the README tells the judge to do.

### P2-1 — `create_issue` and `comment_on_issue` are published with `readOnlyHint: true`

- **Repro:** `tools/list` → `annotations.readOnlyHint === true` for `create_issue` and `comment_on_issue`; both tools **write** (they open an issue and add a comment).
- **Expected:** a write tool must not be advertised as read-only. The MCP annotations are what a host uses to decide whether it may auto-run a call; `readOnlyHint: true` tells the host "this call changes nothing".
- **Actual:** `readOnlyHint` is derived from `destructive` (`readOnlyHint: !tool.destructive` in `apps/server/src/mcp/server.ts`), so every non-destructive tool is published as read-only — including the two that mutate state.
- **Suspected area:** server — `apps/server/src/mcp/server.ts` (and the catalogue, which carries the same flag).
- **Suggested owner:** BACKEND. Add an explicit `readOnly` flag to the tool definition (or derive it from a `writes` flag) so the two write tools are published as `readOnlyHint: false, destructiveHint: false`.
- **Note:** `create_issue` / `comment_on_issue` are *reversible* state changes, so `destructiveHint: false` is defensible; `readOnlyHint: true` is simply wrong.

### P2-2 — At the committed HEAD, `.env.example` and `src/config.ts` disagree and the server will not boot

- **Repro:**
  ```bash
  cp .env.example .env && node apps/server/dist/index.js
  # Failed to start Muca: ZodError: invalid_value … "AI_PROVIDER" … expected one of "openai"|"bedrock"
  ```
  The committed `.env.example` sets `AI_PROVIDER=auto` and documents `ANTHROPIC_API_KEY/ENDPOINT/MODEL`, `GEMINI_API_KEY`, `OPENAI_ENDPOINT` and `AI_PROBE_TIMEOUT_MS`; the committed `config.ts` only accepts `openai|bedrock` and reads `OPENAI_BASE_URL` (not `OPENAI_ENDPOINT`). `NODE_ENV` is read by the code but is not in the template.
- **Expected:** the documented setup (`cp .env.example .env`) must produce a server that starts.
- **Actual:** the server exits with a Zod error; the API is unreachable.
- **Suspected area:** config.
- **Status:** **already fixed in the in-flight working tree** (the gateway accepts `auto` and reads the new names). It is only a problem if the tree is shipped at `1e8f908`, or if `.env.example` and the gateway are committed separately.
- **Suggested owner:** BACKEND/HEAD — commit the gateway and `.env.example` together, and re-run the "no `.env`" and "`cp .env.example .env`" boots.

### P2-3 — The timeline shows a stale `DECLINED` row next to the live `WAITING` row (worse than the known issue)

- **Repro:** run any destructive request in the UI (with a provider configured). The timeline shows, for the *same* call:
  1. `Create Branch / create_branch / DESTRUCTIVE / DECLINED` (with "Show arguments (2)")
  2. `Approval required / create_branch / DESTRUCTIVE / WAITING` — the live prompt with the Approve/Cancel buttons.
  After pressing **Cancel** there are **two** `DECLINED` rows.
- **Expected:** one row per call, showing that the user has not decided yet.
- **Actual:** the backend now emits `approval_decision` (approved: false) **before** `confirmation_required` when a run parks. `lib/timeline.ts` folds the decision into the tool-call row and marks it `rejected`; the following `confirmation_required` then creates a **second** row because the call step is no longer in `pendingCalls`. The known issue was described as "after a cancelled attempt"; in fact it is present on **every** first park, and it reads as if the user had already declined.
- **Suspected area:** web — `apps/web/lib/timeline.ts` (the `approval_decision` / `confirmation_required` ordering) or the server's event order.
- **Suggested owner:** FRONTEND. Either ignore an `approval_decision` with `approved:false` when it is immediately followed by a `confirmation_required` for the same call id, or change the server to emit `confirmation_required` first.

### P2-4 — The README describes a product that no longer exists

- **Repro:** read `README.md` lines 157–175 and 236–253.
- **Expected:** the README is the judge's entry point and should describe what the app does.
- **Actual:** it still documents seven placeholder tools (`create_note`, `list_notes`, `get_note`, `delete_note`, `clear_notes`, `get_weather`), says "Placeholder tools … Replace them once the use case is decided" and lists "**No real use case yet**" as a known limitation — while the product is an Ops Copilot with ten tools, MCP Tasks and elicitation. The API table also omits `/runs` and `/tasks`. The Quick start points at the broken `npm run dev` (P1-2).
- **Suspected area:** docs.
- **Suggested owner:** HEAD (or BACKEND/FRONTEND for the technical parts). This is the cheapest credibility win available before the deadline.

### P3-1 — Malformed tool input is reported as an `isError` tool result, not a JSON-RPC `error`

- **Repro:** raw `tools/call` with an unknown tool / a wrong argument type → HTTP 200, `{"result":{"content":[{"type":"text","text":"MCP error -32602: …"}],"isError":true}}`.
- **Expected:** the brief says "a clean JSON-RPC error".
- **Actual:** the response is well-formed and carries the SDK's `-32602` code in the text, with no stack trace and no 500 — this is the MCP SDK's standard tool-error shape, and a client sees a clean failure. I would accept it, but a judge reading the brief literally may call it a miss.
- **Suspected area:** server — the SDK's default `McpServer` tool error handling.
- **Suggested owner:** BACKEND, only if a strict reading matters.

### P3-2 — `npm run lint` fails at the committed HEAD

- **Repro:** in the clean clone of `1e8f908`: `npm run lint` → `apps/server/src/mcp/tasks.ts:1:10 'z' is defined but never used`.
- **Cause:** `f5077c2` moved the diagnose schema into `catalogue.ts` but left the `zod` import behind.
- **Status:** **already fixed in the working tree** (the import is removed); the committed tree fails the repo's own lint script.
- **Suggested owner:** HEAD — commit the fix with the gateway.

### P3-3 — The production build needs network access to `fonts.googleapis.com`

- **Repro:** in the clean clone, the first `npm run build` failed with `Module not found … @vercel/turbopack-next/internal/font/google/font?{…"url":"https://fonts.gs…"}`; the retry succeeded.
- **Cause:** `apps/web/app/layout.tsx` uses `next/font/google` (Geist / Geist Mono), which is fetched at build time.
- **Impact:** a judge who builds offline cannot produce a bundle. The **dev** path is affected the same way.
- **Suspected area:** web.
- **Suggested owner:** FRONTEND — self-host the font (`next/font/local`) if the deadline allows. This is the known sandbox issue, but it bit the *production build*, not only `next dev`.

### P3-4 — The probe says "No API key configured." when the real reason is a missing model

- **Repro:** `ANTHROPIC_API_KEY` set, `ANTHROPIC_MODEL` empty → `/health` reports `{"provider":"anthropic","status":"not_configured","detail":"No API key configured."}`.
- **Impact:** misleading diagnostics in the judge-facing panel. The behaviour itself is correct (the server boots and stays without a model).
- **Suspected area:** server — `apps/server/src/ai/probe.ts` (`isConfigured`).
- **Suggested owner:** BACKEND.

### P3-5 — `apps/web/AGENT.md` contradicts the code

- `apps/web/AGENT.md:58` still says "The web client does not talk to MCP directly", but `apps/web/lib/mcp.ts` is a real MCP client in the browser. The FRONTEND agent flagged this itself.
- **Suggested owner:** FRONTEND.

---

## Not tested / limitations

- **Section G was verified against an uncommitted tree.** The gateway landed in the working tree at ~22:00 and was still uncommitted when I finished. Re-run `probe-gateway.mjs`, `probe-gemini.mjs` and the G1 boots against the **committed** tree before shipping.
- **The real model was never used.** The sandbox cannot reach `api.openai.com`, and the repo's `.env` holds a dummy key. Every agent-loop test used a scripted OpenAI-compatible stub (`/tmp/opencode/stub-openai.mjs`) and the gateway tests used local provider stubs (`/tmp/opencode/gw-stub.mjs`). The HTTP route, the registry, the gate, the MCP transport and the provider adapters are the product's; only the LLM HTTP endpoint was substituted. All stub code lives under `/tmp/opencode/` and is **not** part of the submission.
- **Alexa+ is not claimed and was not tested** — Muca has no Alexa+ integration.
- **Bedrock** was not exercised against AWS (no credentials); only its unit tests were run.
- **The Anthropic adapter was not exercised end to end** beyond its probe: my Anthropic stub answers the probe but returns no `messages` payload, so no Anthropic chat turn was driven.
- **Persistence / multi-session behaviour** was not tested: the tool state, the pending-approval registry and the MCP task store are in memory, and the run history is file-backed. A restart clears the pending approvals (correct for an approval, but worth knowing).
- **The `npm run dev` failure (P1-2) was observed on the committed tree and is still present in the working tree** (the root `package.json` was not touched by the gateway work).
- **Port discipline:** during the second half of the run the BACKEND agent's server occupied 8099, so my clean-clone server and the stub endpoints ran on 8091–8098 / 8198 / 8301–8303. That is tester infrastructure; the application itself only ever opened one socket (C1.4).

---

## Recommendation

- **Fix before the deadline (P1):**
  1. **P1-1** — retire an approval in the `PendingApprovalRegistry` on every request, not only when the run completes. One line in `apps/server/src/http/api.ts`; the brief's §B4 is a stated acceptance criterion.
  2. **P1-2** — point the root `npm run dev` at `@muca/server` (verified working) so the documented quick start serves the app, the API and MCP on 8099.
- **Then (P2):** correct the `readOnlyHint` on the two write tools, commit the gateway **together with** `.env.example` and the lint fix, and refresh the README (tool list, "no real use case", API table, quick start).
- **Then (P2-3):** fix the `DECLINED`/`WAITING` duplication — it is on every first park, not only after a cancel, and it is the first thing a judge sees in the approval flow.
- **Ship-blocking answer:** the MCP layer is in good shape. The protocol is genuinely used (stateful sessions, tasks, elicitation, correct annotations on the destructive tools, clean error handling), the approval gate holds against fabricated ids, reused ids and different arguments, and the single-port promise is real. The two P1s are small, localised fixes; the rest is polish and documentation.
- **Re-test after the gateway is committed** — section G, plus one re-run of §B against the final tree.
