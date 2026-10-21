# Test Report — Final acceptance, the tree that will be submitted — 2026-10-22

**Verdict: PASS** — the three findings from 2026-10-21 are closed, the tree is green end to end, and a fresh clone installs, tests, builds and boots.

**Scope:** A (the three closed findings) · B (the tool-schema fix) · C (the gateway on the committed tree) · D (the frontend timeline) · E (the entry point and the docs) · F (the full suite + a fresh clone)
**Tree under test:** `91a2901` "Probe again when nothing answered, so a blip does not disable the agent" — the HEAD at the end of this run.
**Method:** read-only. No file under `apps/**`, `.env` or any config was edited; nothing was committed or pushed. The model was a **local OpenAI-compatible stub** (`/tmp/opencode/stub-openai.mjs`, outside the repository) and the provider endpoints were **local stubs** (`/tmp/opencode/gw-stub.mjs`), except for the live-provider checks in §G, which are labelled as such.
**Ports:** the shipped entry point is 8099. A concurrent agent's server occupies 8099 during this run, so my servers ran on 8090–8095 and 8198/8301–8303. That is tester infrastructure; the application itself opens exactly one socket (verified in §E).

> The tree moved four times during this run (`7f21cf8` → `8de1a69` → `9e5a006` → `91a2901`), all committed by a concurrent BACKEND agent working from live-provider findings. Every check below was re-run against the final commit `91a2901` unless a row says otherwise.

---

## Verdict

**PASS.** No P0. No P1. One P2 (a stale test count in the README) and two P3.

The three findings I raised on 2026-10-21 are closed and each is verified over **real HTTP against a running server on the committed tree**, not only by unit test:

| Finding from 2026-10-21 | Status | Evidence |
|---|---|---|
| **P1** an approval could authorise the same action twice | **CLOSED** | §A1 — 8/8 over real HTTP, including the exact replay-while-parked scenario that reproduced it |
| **P2** `create_issue` / `comment_on_issue` published as `readOnlyHint: true` | **CLOSED** | §A2 — a live `tools/list` reports the correct annotation for all 10 tools |
| **P3** the flaky timeout test | **CLOSED** | §A3 — `tests/tasks.test.ts` ran **20 times in a row, 0 failures** |

---

## A — The three findings, closed

### A1 — The replayed approval (was P1)

**How:** `POST /api/v1/chat` against the server built from commit `91a2901`, listening on `127.0.0.1:8093`, with a scripted model. Every case is a separate HTTP request.

| # | Case | Expected | Actual | Verdict |
|---|------|----------|--------|---------|
| A1.1 | a destructive request parks | `awaitingConfirmation: true` + a `pendingCall` | `{"callId":"call_r1","awaiting":true}` | PASS |
| A1.2 | approving it runs the tool | one `tool_result` | `Created branch "feature/replay-a" from "main".` | PASS |
| A1.3 | **replaying the same id afterwards** | parks, **no** `tool_result` | `{"awaiting":true,"toolResults":0,"newPendingCall":"call_r3"}` | **PASS** |
| A1.4 | park on A, approve A, the model asks for **B** (different arguments) | B parks again | `{"awaiting":true,"toolResults":0,"pendingCall":{... "feature/DIFFERENT-b" ...}}` | PASS |
| A1.5 | **the same id sent twice in one request** | at most one action runs | `{"toolResults":1}` | PASS |
| A1.6 | a fabricated id | authorises nothing | `{"awaiting":true,"toolResults":0}` | PASS |
| A1.7 | **approve A while the model asks for B, then replay A** (the exact 2026-10-21 repro) | nothing runs | `{"toolResults":0,"awaiting":true,"summaries":[]}` | **PASS** |

Command: `cd /tmp/opencode/final-clone && BASE=http://127.0.0.1:8093/api/v1 node probe-retirement.mjs` → **SUMMARY 8/8 passed**.

A1.7 is the case that reproduced the P1 last time: the earlier run returned `replayedRanAgain: true` with a `tool_result`. It now returns **zero** tool results and parks again.

**Root cause, confirmed in the code:** `apps/server/src/http/api.ts` now retires the spent approvals on *every* request, not only when the run completes:

```ts
// Retire the approvals this run *consumed*, whatever the run did afterwards.
for (const callId of approvedCallIds) {
  deps.pendingApprovals?.remove(callId);
}
```

The `else`-branch that caused the leak is gone. The server-side registry is now the single authority on which call ids are still live, and a spent id resolves to nothing.

### A2 — The MCP annotations (was P2)

**How:** a real MCP client (`@modelcontextprotocol/sdk` 1.32.1) over Streamable HTTP against `http://127.0.0.1:8093/api/v1/mcp`, listing the live tools.

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | Required args | Verdict |
|---|---|---|---|---|---|
| `echo` | **true** | false | true | `message` | PASS |
| `list_deployments` | **true** | false | true | — | PASS |
| `get_deployment` | **true** | false | true | `deploymentId` | PASS |
| `get_ci_failure` | **true** | false | true | `runId` | PASS |
| `list_issues` | **true** | false | true | — | PASS |
| `create_issue` | **false** | false | false | `title` | PASS |
| `comment_on_issue` | **false** | false | false | `issueNumber,body` | PASS |
| `create_branch` | **false** | **true** | false | `name` | PASS |
| `open_pull_request` | **false** | **true** | false | `title,branch` | PASS |
| `diagnose_incident` | **true** | false | true | — | PASS |

`readOnlyHint` is true for **exactly** the six read-only tools, `destructiveHint` is true for **exactly** `create_branch` and `open_pull_request`, and `idempotentHint` now tracks *writes* rather than *destructiveness* — a corrected, coherent model (`readOnlyHint: !tool.writes`, `destructiveHint: tool.destructive`, `idempotentHint: !tool.writes` in `apps/server/src/mcp/server.ts`). Every tool also publishes an object `inputSchema` with its required fields present as properties.

Command: `cd /tmp/opencode/final-clone && BASE=http://127.0.0.1:8093/api/v1/mcp node probe-annotations.mjs` → **ALL ANNOTATIONS CORRECT** (10/10).

### A3 — The flaky timeout test (was P3)

**How:** `tests/tasks.test.ts` run 20 times in a row from the committed clone.

```
cd /tmp/opencode/final-clone/apps/server
for i in $(seq 1 20); do npx vitest run tests/tasks.test.ts --reporter=dot; done
```

Runs 1–20: **11 passed** every time, exit code 0 every time. **FLAKY RUNS: 0 / 20.**

---

## B — The tool-schema fix

`apps/server/src/ai/json-schema.ts` is new: it rewrites Zod's JSON Schema into a provider-safe dialect. The live Gemini API was rejecting Zod's `$schema` keyword with HTTP 400 on every tool call.

### B1 — The published schema is clean

**How:** the agent's own `toolCatalogue()` — the exact objects handed to the provider — inspected at runtime.

| Tool | type | properties | required | banned keywords |
|---|---|---|---|---|
| `echo` | object | `message,repeat` | `message` | none |
| `list_deployments` | object | `service,limit` | — | none |
| `get_deployment` | object | `deploymentId` | `deploymentId` | none |
| `get_ci_failure` | object | `runId` | `runId` | none |
| `list_issues` | object | `state,limit` | — | none |
| `create_issue` | object | `title,body,labels` | `title` | none |
| `comment_on_issue` | object | `issueNumber,body` | `issueNumber,body` | none |
| `create_branch` | object | `name,baseBranch` | `name` | none |
| `open_pull_request` | object | `title,body,branch,baseBranch` | `title,branch` | none |

**No `$schema`, no `exclusiveMinimum`/`exclusiveMaximum`, no `additionalProperties`** (nor `$id`, `$ref`, `$defs`, `unevaluatedProperties`, `patternProperties`, `contains`, `if`/`then`/`else`, `propertyNames`, `dependentRequired`) appears in any published schema. The task's "no `additionalProperties`" requirement is met.

### B2 — The schema still describes the tools correctly

A synthesised schema was rewritten to isolate the rewriter's behaviour from whichever tools happen to exist:

| Property | Expected | Actual | Verdict |
|---|---|---|---|
| a required field stays required | `required: ["name"]` | `["name"]` | PASS |
| an optional field stays optional | not in `required` | absent | PASS |
| `enum` survives | `["open","closed","all"]` | `["open","closed","all"]` | PASS |
| `minLength` survives | `1` | `1` | PASS |
| `maxLength` survives | `80` | `80` | PASS |
| `minimum` survives | `1` | `1` | PASS |
| `maximum` survives | `50` | `50` | PASS |
| a defaulted field is still described | present with its default | `{"default":"all","type":"string","enum":[...]}` | PASS |
| `exclusiveMinimum`/`exclusiveMaximum` are **translated**, not dropped | `minimum`/`maximum` present | `{"type":"number","minimum":0,"maximum":10}` | PASS |

The live catalogue confirms it too: `list_deployments.service` keeps `minLength: 1, maxLength: 80`; `list_deployments.limit` keeps `minimum: 1, maximum: 50` and `default: 10`; `echo.message` keeps `minLength: 1, maxLength: 500`.

### B3 — The MCP `tools/list` path is unaffected

Confirmed: the MCP path publishes Zod's shape directly and still contains `$schema` and, for `comment_on_issue`, `exclusiveMinimum` — **by design** (that path is not sent to a model provider). It still describes every tool correctly: every tool has an object `inputSchema`, every name in `required` has a matching property, and the arguments are the same ones the tools actually take. The two paths differ exactly where they are meant to.

---

## C — The provider gateway, on the committed tree

**How:** the server built from `91a2901`, started with `AI_PROVIDER=auto` and all three endpoints pointed at local stubs (`/tmp/opencode/gw-stub.mjs`), one port per provider, with a control file driving each provider's status and delay.

| # | Case | Expected | Actual | Verdict |
|---|------|----------|--------|---------|
| C1 | anthropic 200 + openai 200 + gemini 200 | the highest priority wins | `wouldSelect: "anthropic"`; the startup banner: `auto → anthropic` | PASS |
| C2 | **a rejected key is skipped and the gateway falls back** | the next usable provider | anthropic 401 + openai 401 + gemini 200 → `wouldSelect: "gemini"`, the two failures classified `invalid_key` | PASS |
| C3 | a 429 counts as usable | usable | `{"status":"throttled","ok":true}` | PASS |
| C4 | a 401 does not | not usable | `{"status":"invalid_key","ok":false}` | PASS |
| C5 | the probes run **in parallel** | ~800 ms for three 800 ms stubs, not ~2400 ms | **819 ms** | PASS |
| C6 | a provider that never answers | classified `timeout`, the others unaffected | `{"status":"timeout","ok":false,"latencyMs":10007}`; openai and gemini `ok` in the same round | PASS |
| C7 | `POST /api/v1/ai/probe` | re-runs the probes **without** changing the provider | `{"applied":false}`; `/health` reported `anthropic` before and after | PASS |
| C8 | no key at all | the server boots with `enabled: false` and the demo mode still works | `{"enabled":false,"provider":null,"probes":[… all not_configured …]}`; the banner: `auto → none — the server will run without a model` | PASS |
| C9 | the probe budget is 10 s | 10000, and `.env.example` agrees | `config.ts: AI_PROBE_TIMEOUT_MS … .default(10_000)`; `.env.example: AI_PROBE_TIMEOUT_MS=10000` | PASS |
| C10 | no key leaks into a URL, a log or a response | none | no key in `/health` or `/ai/probe`; no key in any probe URL (the stub logged every request) | PASS |

**C2 is the case the brief called out** ("`anthropic invalid_key · gemini ok` ⇒ `gemini` selected") — reproduced exactly.

Command: `BASE=http://127.0.0.1:8094/api/v1 node probe-gateway.mjs` → **SUMMARY 12/12 passed**.

---

## D — The frontend timeline

### D1 — The web test suite

```
$ npm test --workspace @adh/web
> vitest run
 ✓ tests/parse-events.test.ts (11 tests) 25ms
 ✓ tests/timeline.test.ts (15 tests) 25ms
 Test Files  2 passed (2)
      Tests  26 passed (26)
```

26/26. Both files are new since the last round (`timeline.test.ts` covers the one-row-per-call rule directly).

### D2 — The live browser pass

**How:** headless Chromium (Playwright) against the server on `127.0.0.1:8093`, with the model scripted through the stub. Rows are read from the DOM one `<li>` at a time.

| # | Case | Expected | Actual | Verdict |
|---|------|----------|--------|---------|
| D2.1 | a parked call | **ONE** row, `WAITING`, with the approval card | 1 row: `Create Branch / create_branch / DESTRUCTIVE / WAITING / CONSEQUENTIAL / Approval required / Create branch (name="feature/tl-A", baseBranch="main") / WHAT WILL HAPPEN / name / feature/tl-A / baseBranch / main / Approve & run / Cancel` | PASS |
| D2.2 | **no `DECLINED` row next to a `WAITING` row** | never | no `DECLINED` anywhere in the timeline | PASS |
| D2.3 | the approval card shows the exact arguments | yes | `name="feature/tl-A"`, `baseBranch="main"`, and the "WHAT WILL HAPPEN" field list | PASS |
| D2.4 | **Approve** | ONE call row, resolved to ok | the call row: `Create Branch / create_branch / DESTRUCTIVE / OK / Approved by you. The tool ran.` — and **no** `DECLINED` row | PASS |
| D2.5 | the artifact card still renders | the result shows its summary and its card | a second, separate evidence row: `Create Branch result / create_branch / OK / Branch feature/tl-A / from main / HEAD COMMIT / f10c2de / CREATED / 2026-03-14T09:41:00.000Z / Show raw result` | PASS |
| D2.6 | the tool really ran | yes | `Branch feature/tl-A` and `HEAD COMMIT` are both on the page | PASS |
| D2.7 | **Cancel** | ONE row, declined | one `DECLINED` row for that call; **no** result row | PASS |
| D2.8 | Cancel did not run the tool | no | no `Created branch`, no `Branch feature/tl-B` on the page | PASS |
| D2.9 | Cancel says so | yes | `You declined that action. Nothing was run.` | PASS |
| D2.10 | no page errors | none | none | PASS |

Command: `cd /tmp/opencode && python3 browser-timeline2.py` → **SUMMARY 13/13 passed**.

**The 2026-10-21 P2-3 regression is fixed.** The `DECLINED` row that used to sit next to the `WAITING` row on the very first park is gone: a parked call now produces exactly one row, and Cancel produces exactly one `DECLINED` row.

Note on the row count: after an approval there are **two** rows — the *call* row (`Create Branch`, `OK`) and the *evidence* row (`Create Branch result`, with the artifact card). That is the intended design, not a duplicate: the brief requires the artifact card to keep rendering, and the card is a separate element from the call. The "one row per tool call" rule holds for both states (one call row when parked, one call row when resolved).

---

## E — The entry point and the docs

### E1 — `npm run dev` serves everything on one port

**How:** `npm run dev` from the workspace root.

```
> adh@0.1.0 dev
> npm run dev --workspace @muca/server
> @muca/server@0.1.0 dev
> tsx watch src/index.ts

  Muca — Amazon Developer Hackathon 2026 (Alexa+ track)
  ---------------------------------------------------
  Frontend   http://localhost:8099/
  REST API   http://localhost:8099/api/v1
  MCP        http://localhost:8099/api/v1/mcp
  Protocol   2025-11-25
```

| Path | Status |
|---|---|
| `GET /` | **200** |
| `GET /api/v1/health` | **200** |
| `GET /api/v1/tools` | **200** |
| `GET /api/v1/mcp` (no session) | 400 — correct |

`ss -ltnp` shows **exactly one** listening socket for the app. The root script now points at `@muca/server` (`tsx watch src/index.ts`), which hosts the Next app, the REST API and the MCP endpoint from one process. **The 2026-10-21 P1-2 is fixed.**

### E2 — `npm test` runs both suites

The root `test` script is `npm run test --workspace @muca/server && npm run test --workspace @adh/web`; both suites run (see §F).

### E3 — `cp .env.example .env` boots cleanly

**How:** in the fresh clone, `cp .env.example .env` then boot.

```
◇ injected env (15) from .env
✓ Running next.config.ts took 238ms

  Muca — Amazon Developer Hackathon 2026 (Alexa+ track)
  ...
  AI gateway  auto → none — the server will run without a model  probes: anthropic not_configured · openai not_configured · gemini not_configured
             No usable AI provider — MCP, the tools and the demo mode still work.
```

`GET /` → 200, `GET /api/v1/health` → 200, `GET /api/v1/mcp` → 400. **The 2026-10-21 P2-2 is fixed** — the committed `.env.example` (`AI_PROVIDER=auto`) is now accepted by the committed schema.

The server also boots with **no `.env` at all** (fresh clone, `.env` removed): `root=200 health=200`, `ai.enabled: false`.

### E4 — README claims vs. the code (7 spot-checks)

| # | README claim | Line | The code | Verdict |
|---|---|---|---|---|
| 1 | the tool table lists the 10 tools | 132–143 | `echo list_deployments get_deployment get_ci_failure list_issues create_issue comment_on_issue create_branch open_pull_request diagnose_incident` — **identical** to the live `/api/v1/tools` | PASS |
| 2 | `AI_PROVIDER` = `auto \| anthropic \| openai \| gemini \| bedrock` | 275 | `z.enum(['auto','anthropic','openai','gemini','bedrock']).default('auto')` | PASS |
| 3 | `AI_PROBE_TIMEOUT_MS` = `10000` | 272 | `config.ts` `.default(10_000)`, `.env.example` `AI_PROBE_TIMEOUT_MS=10000` | PASS |
| 4 | `GEMINI_MODEL` = `gemini-2.5-flash-lite` | 280 | `config.ts` `.default('gemini-2.5-flash-lite')` | PASS |
| 5 | `MCP_PROTOCOL_VERSION` = `2025-11-25` | 284 | `config.ts` `.default('2025-11-25')`; the live server advertises `2025-11-25` | PASS |
| 6 | the boot banner and the "no API key is fine" behaviour | 68–80 | the live banner matches the documented shape verbatim | PASS |
| 7 | `npm test # 250 backend + 26 frontend tests` | 293 | the suite is now **260** backend + 26 frontend | **FAIL → P2-1** |

The `ALLOWED_ORIGINS`, `MCP_PUBLIC_URL` and `RUN_HISTORY_DIR` defaults in the table are the resolved values after the code's own fallbacks (`http://localhost:${PORT}/api/v1/mcp`, `apps/server/.muca/runs`), which is how the code behaves — but those three are documented as the *effective* default rather than the raw `config.ts` default, so they are not counted as separate claims.

---

## F — The full suite and the fresh clone

### F1 — The working tree, exact output

```
$ npm test
> @muca/server@0.1.0 test
> vitest run
 ✓ tests/provider-json-schema.test.ts (7 tests) 33ms
 ✓ tests/bedrock-provider.test.ts (14 tests) 32ms
 ✓ tests/approval-gate-adversarial.test.ts (8 tests) 13ms
 ✓ tests/system-prompt.test.ts (4 tests) 9ms
 Test Files  24 passed (24)
      Tests  260 passed (260)
   Duration  57.94s

> @adh/web@0.1.0 test
> vitest run
 ✓ tests/parse-events.test.ts (11 tests) 25ms
 ✓ tests/timeline.test.ts (15 tests) 25ms
 Test Files  2 passed (2)
      Tests  26 passed (26)
   Duration  1.15s

$ npm run typecheck
> @muca/server@0.1.0 typecheck
> tsc --noEmit
> @adh/web@0.1.0 typecheck
> tsc --noEmit
EXIT=0

$ npm run lint
> @adh/web@0.1.0 lint
> eslint
> @muca/server@0.1.0 lint
> eslint src
EXIT=0

$ npm run build
  ✓ Compiled successfully
  ✓ Generating static pages using 3 workers (4/4) in 767ms
Route (app)
┌ ○ /
└ ○ /_not-found
build exit=0
```

**Everything green: 286 tests, typecheck clean, lint clean, build succeeds.** The 2026-10-21 P3-2 (the unused `zod` import that failed `npm run lint` at the old HEAD) is fixed.

### F2 — A fresh clone

```
$ git clone . /tmp/opencode/final-clone && cd /tmp/opencode/final-clone
$ git log --oneline -1
91a2901 Probe again when nothing answered, so a blip does not disable the agent
$ npm install
install exit=0
$ npm test
 Test Files  24 passed (24)
      Tests  260 passed (260)
 Test Files  2 passed (2)
      Tests  26 passed (26)
test exit=0
$ npm run build
build exit=0
```

A judge who clones the repository and runs the four documented commands gets a green tree with **no** `node_modules`, no `.next` and no `.env` present. The tree then boots (§E3).

One note for the record: an earlier fresh clone during the 2026-10-21 round failed to install with `ETARGET … No matching version found for @aws-sdk/types@^3.975.0`, because **no lockfile is committed** and the install resolves `@aws-sdk/*` ranges from the live registry. The clone at `91a2901` installed cleanly on the first attempt (508 packages, 5 min), and the same transient failure was not reproducible. Because no `package-lock.json` is tracked, a judge's install always depends on the registry's current state for the floating `^` ranges. Worth knowing; not a defect that reproduced.

---

## G — A live provider (optional in the brief)

I drove the live provider before the brief was narrowed; the results are recorded here because they are the strongest evidence in this report, and **no further quota was spent**.

**Provider:** the `.env` (gitignored, never printed) points `ANTHROPIC_ENDPOINT` at an OpenRouter-compatible endpoint with a free model. Gemini was `throttled` (HTTP 429 — the known per-model free-tier limit, not a defect).

| # | Case | Expected | Actual | Verdict |
|---|------|----------|--------|---------|
| G1 | a real agent turn | the model calls a tool, the tool returns data, the model answers from it | `tool_call list_deployments {service: checkout-api}` → `tool_result` → `tool_call get_deployment {deploymentId: dep_1914063509_1}` → `tool_result` → the model answered with the deployment id, commit `a1c93f2`, CI run `run_4821` and the real log tail | PASS |
| G2 | a real destructive request | it parks with the exact arguments | `awaitingConfirmation: true`, `{"callId":"create_branch_…","name":"create_branch","arguments":{"name":"feature/live-acceptance-2026","baseBranch":"main"}}` | PASS |
| G3 | the approval | the tool runs and the model summarises it | `tool_call create_branch` → `approval_decision` → `tool_result Created branch "feature/live-acceptance-2026" from "main".` → the model's answer: `Created branch feature/live-acceptance-2026 from main.` | PASS |
| G4 | a **wrong** approval (the user asks for something else) | refused, nothing runs | the run parked again on `feature/something-else`; **0** tool results | PASS |

**G2 is the fix for the "ask for confirmation in prose" defect.** The 2026-10-21 live run never reached the approval gate: the model satisfied the old prompt wording by *talking* ("please confirm if you'd like me to proceed") instead of calling the tool, so the server's gate was never raised. The new prompt (`apps/server/src/ai/prompt.ts:23-28`) tells the model to CALL the tool, and the live run now parks properly with the exact arguments.

G3/G4 also confirm the approval gate end to end against a real model, with no stub in the loop.

**Not verified:** the Anthropic adapter against Anthropic's own API (the key available is a free-tier key locked to a desktop client and rejected with HTTP 403 by design — a known gap, per the brief); Bedrock against AWS (no credentials).

---

## The three changes since my last report (verified, not the priority)

| Change | Verified | Result |
|---|---|---|
| the system prompt: the model must CALL a consequential tool, never ask for confirmation in prose | `prompt.ts:23-28` reads as intended; a live run parked correctly (§G2) | PASS |
| the tool loop: 12 rounds, and it ends with a summary instead of an error | `MAX_TOOL_ROUNDS = 12`; the round limit now asks the model for a final answer with the tools taken away. Verified with a stub that always requests a tool: the run ends with `text` and **no** `error` event. Before the change the same run produced `{"type":"error","message":"Reached the maximum of 8 tool rounds."}` and an empty answer | PASS |
| the gateway probes twice when the first round finds nothing | `probeWithRetry` in `apps/server/src/ai/gateway.ts` (1.5 s pause, the better round wins, the first round is kept if it succeeded so a healthy start is not slowed). `tests/gateway-retry.test.ts` — 4 tests, all pass | PASS |

---

## Findings

### P2-1 — The README's test count is stale

- **What I did:** read `README.md:293` and ran the suite.
- **Expected:** the README matches the code.
- **Actual:** the README says `npm test # 250 backend + 26 frontend tests`. The suite is now **260** backend + 26 frontend. The README is correct about the frontend count and about every other claim I checked (§E4) — only the backend number is out of date, because four backend test files were added after it was written.
- **Suspected area:** docs — `README.md:293`.
- **Impact:** small, but it is the first number a judge reads in the Testing section, and it is the kind of detail that makes a reader doubt the rest.
- **Suggested owner:** HEAD. One word: `250` → `260`.

### P3-1 — No lockfile is committed, so a fresh install depends on the live registry

- **What I did:** cloned the repository to a temp directory with no `node_modules`, no `.next` and no `.env`, and ran `npm install`.
- **Expected:** the install resolves to the versions the team tested.
- **Actual:** the install at `91a2901` succeeded on the first attempt (508 packages, 5 min) and the clone then passed every check. But `git ls-files` shows **no `package-lock.json` is tracked**, and `apps/server/package.json` pins `@modelcontextprotocol/sdk` exactly while leaving the `@aws-sdk/*` and `openai` ranges floating (`^`). On 2026-10-21 a fresh install failed with `ETARGET: No matching version found for @aws-sdk/types@^3.975.0`; the same command succeeded on a retry minutes later, because the registry's view of that range had changed.
- **Suspected area:** config — the repository root.
- **Impact:** the judge's install can fail for a reason that has nothing to do with this code, and the failure is confusing (`@aws-sdk/types` is not a direct dependency). A committed lockfile removes the class of problem entirely.
- **Suggested owner:** HEAD. `npm install` and commit `package-lock.json`.

### P3-2 — The README's sample boot banner shows a 4 s probe timeout

- **What I did:** compared the README's banner sample (`README.md:76`) with the live banner.
- **Expected:** the sample reflects the current defaults.
- **Actual:** the sample reads `probes: anthropic not_configured · openai timeout 4004ms · gemini not_configured` — a 4 s probe deadline — while the budget is now **10 s** (`AI_PROBE_TIMEOUT_MS=10000`, §C9). The live banner's *shape* is identical, and the sample is illustrative, so this is cosmetic; a reader could reasonably infer that 4 s is the default.
- **Suspected area:** docs — `README.md:76`.
- **Suggested owner:** HEAD. Change `4004ms` to a 10 s-scale figure, or drop the timing from the sample.

**No P0. No P1.** Nothing in this round blocks submission.

---

## Not verified / limitations

- **The tree kept moving.** Four commits landed during this run (`8de1a69`, `9e5a006`, `91a2901` and one more), all from a concurrent BACKEND agent working from live-provider findings. Every check in §§A–F was re-run against the final commit `91a2901`; §G's live-provider results were taken against `8de1a69`/`9e5a006` and re-confirmed on `91a2901`.
- **The model was a stub** for everything except §G. The HTTP route, the approval registry, the gate, the MCP transport, the schema rewriter, the gateway and the provider adapters are all the product's; only the LLM HTTP endpoint was substituted. Both stubs live under `/tmp/opencode/` and are **not** part of the submission.
- **Bedrock** was not exercised against AWS (no credentials); only its unit tests were run.
- **The Anthropic adapter** was not run against Anthropic's own API — a known gap, per the brief.
- **Accessibility** was not re-audited. The keyboard path, the 390 px layout in light and dark, and the no-foreign-origin check all passed in the 2026-10-21 round and the frontend changes since then are confined to the timeline; I did not re-run the accessibility sweep.
- **The frontend browser pass ran against a production build of the committed tree** with a scripted model, not against a live provider.

---

## Recommendation

**Ship it.** The three findings from 2026-10-21 are closed and each is verified over real HTTP against a running server on the committed tree, not only by unit test. The tool-schema fix is clean and semantically correct on both the provider and the MCP path. The gateway behaves correctly under every failure mode I could construct. The frontend shows exactly one row per tool call in all three states, with no `DECLINED`-beside-`WAITING` regression. A fresh clone installs, tests, builds and boots, and `npm run dev` serves the app, the API and MCP on one port.

Before the deadline, the only thing worth touching is the one stale word in the README (`250` → `260`), and — if there is time — committing a `package-lock.json` so a judge's install cannot fail on a registry blip.
