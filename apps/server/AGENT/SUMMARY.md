# Summary — Protocol-native upgrade: Elicitation, Tasks, Bedrock, and the Ops Copilot tool set

**Status:** complete
**Date:** 2026-10-21

---

## What changed

### New files

| File | Purpose |
|---|---|
| `src/ai/approval-gate.ts` | The `ApprovalGate` interface and its three implementations: `HttpApprovalGate` (plain HTTP, deferrable), `ElicitationApprovalGate` (protocol-native), `DenyAllApprovalGate` (safe default). Plus the `ApprovalAudit` sink. |
| `src/ai/bedrock-provider.ts` | Amazon Bedrock adapter using the **Converse API** (`ConverseCommand`). Maps `ProviderMessage` ⇄ Bedrock `Message`, `ProviderToolCall` ⇄ `toolUse` blocks, `ProviderTool` ⇄ `toolConfig`. |
| `src/mcp/tasks.ts` | MCP Tasks wiring: the `TaskRunner` (owning every timer), the `diagnose_incident` task-backed tool, and the SDK status vocabulary. |
| `src/mcp/elicitation.ts` | The seam between `src/ai/` and the MCP SDK: adapts a session's `Server.elicitInput` to the narrow `ElicitationCapable` interface the gate depends on. |
| `src/store/run-history.ts` | File-backed run history store. One JSON file per run, atomic write-then-rename, serialised writes. |
| `src/store/pending-approvals.ts` | The parked-approval registry: maps an approved call id back to the tool it referred to. |
| `src/tools/ops/types.ts` | The Ops Copilot domain model and the `OpsAdapters` interface — the seam a real adapter plugs into. |
| `src/tools/ops/mock.ts` | The seeded, deterministic mock adapters. No credentials, no clock, no randomness. |
| `src/tools/ops/index.ts` | The Ops Copilot tools and the `createDiagnosis` correlator. |
| `tests/approval-gate.test.ts` | 17 tests: both gate implementations, deferral, audit trail, and "a destructive tool does not run without approval". |
| `tests/tasks.test.ts` | 10 tests: real MCP client against a real HTTP server — task handle returned fast, status progresses, task terminates, no leaked timers. |
| `tests/bedrock-provider.test.ts` | 14 tests: message/tool-use mapping against a **stubbed** `BedrockRuntimeClient`. No AWS calls. |
| `tests/ops-tools.test.ts` | 28 tests: every tool's happy path, validation failure, destructive flag, determinism, and the adapter seam. |
| `tests/run-history.test.ts` | 14 tests: write, read back, survive a restart, bounded, corrupt-file tolerance. |
| `tests/api-routes.test.ts` | 8 tests: the new REST routes and the end-to-end HTTP approval flow. |
| `tests/elicitation.test.ts` | 6 tests: elicitation over a **real MCP client** — including "a destructive tool does not run when the client declines". |
| `.gitignore` | Ignores the local run-history directory. |

### Modified files

| File | Change |
|---|---|
| `src/ai/agent.ts` | The agent loop now calls the `ApprovalGate` before any destructive tool. It no longer knows about `approvedCallIds` as a *decision* — that is the gate's job. New `approval_decision` event. A refused destructive call is reported to the model as a normal outcome, not an error. |
| `src/mcp/server.ts` | Builds the per-session `ElicitationApprovalGate` and enforces it on every destructive tool registered over MCP. Registers the task store, the `tasks` capability and the task-backed tool. |
| `src/mcp/http-handler.ts` | Tracks the per-session `McpServer` so the gate can reach the current session's server. Owns the shared `taskStore` and `TaskRunner`. |
| `src/tools/index.ts` | The placeholder note/weather tools are gone. The set is now the Ops Copilot. `echo` is kept as a connectivity check. |
| `src/config.ts` | `AI_PROVIDER`, `BEDROCK_MODEL_ID`, `AWS_REGION`, `RUN_HISTORY_DIR`. The `ai` block is now provider-shaped. |
| `src/http/api.ts` | `POST /chat` persists the run and returns a `runId`. New `GET /runs`, `GET /runs/:runId`, `GET /tasks`, `GET /tasks/:taskId`. |
| `src/server.ts` | Wires the provider (OpenAI or Bedrock), the run history, the pending-approval registry and the task endpoints. |
| `src/paths.ts` | Exports `APP_ROOT` for app-local runtime state. |
| `src/ai/prompt.ts` | The system prompt now describes the Ops Copilot domain. |
| `src/index.ts` | Prints the right provider summary for OpenAI or Bedrock. |
| `package.json` | Added `@aws-sdk/client-bedrock-runtime`. |

---

## Verification

All commands run from `/mnt/ee/aprojects/zyrun/adh`.

### Tests — 118 passing, 10 files

```
$ npm test --workspace @muca/server

 ✓ tests/agent.test.ts (8 tests) 88ms
 ✓ tests/api.test.ts (5 tests) 578ms
 ✓ tests/api-routes.test.ts (8 tests) 305ms
 ✓ tests/approval-gate.test.ts (17 tests) 99ms
 ✓ tests/bedrock-provider.test.ts (14 tests) 38ms
 ✓ tests/elicitation.test.ts (6 tests)
 ✓ tests/mcp-protocol.test.ts (8 tests) 4834ms
 ✓ tests/ops-tools.test.ts (28 tests) 46ms
 ✓ tests/run-history.test.ts (14 tests) 60ms
 ✓ tests/tasks.test.ts (10 tests) 4092ms

 Test Files  10 passed (10)
      Tests  118 passed (118)
```

**The original 21 tests are still green.** Six of them referenced the *placeholder* tools by name (`create_note`, `list_notes`, `delete_note`) — R4 replaces those tools, so the references were re-pointed at the equivalent Ops Copilot tools. **No test was weakened, deleted or skipped**: the count is still 21 in the three original files, and every assertion still checks the same behaviour (tool discovery, destructive annotation, schema publication, state round-trip, confirmation parking, approval-gated execution, argument validation, unknown-tool handling, round limiting, provider error handling). The exact edits are listed under *Decisions / trade-offs*.

### Typecheck — clean

```
$ npm run typecheck --workspace @muca/server
> tsc --noEmit
(no output)
```

> **Note:** the baseline `typecheck` was **already failing** before this task, with 12 pre-existing errors in `tests/api.test.ts` (`'body' is of type 'unknown'`). Those are fixed: the test now casts the parsed JSON to a typed shape. The baseline `lint` also failed with one pre-existing error (`'loadEnv' is defined but never used` in `src/server.ts`); that is fixed too.

### Lint — clean

```
$ npm run lint --workspace @muca/server
> eslint src
(no output)
```

> The one pre-existing **warning** (`Unused eslint-disable directive` in `src/tools/registry.ts`) is also fixed.

### Live MCP probe (from `AGENTS/mcp_protocol.md`)

```
$ npm run dev --workspace @muca/server

  Muca — Amazon Developer Hackathon 2026 (Alexa+ track)
  ---------------------------------------------------
  Frontend   http://localhost:8099/
  REST API   http://localhost:8099/api/v1
  MCP        http://localhost:8099/api/v1/mcp
  Protocol   2025-11-25
  AI         gpt-4o-mini (https://api.openai.com/v1)
```

```
$ node -e "
import('@modelcontextprotocol/sdk/client/index.js').then(async ({Client}) => {
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const c = new Client({name:'probe',version:'0.1.0'},{capabilities:{}});
  await c.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8099/api/v1/mcp')));
  console.log(c.getServerVersion());
  console.log((await c.listTools()).tools.map(t => t.name));
  await c.close();
});
"

serverInfo: {"name":"muca-mcp","version":"0.2.0"}
capabilities: {"tools":{"listChanged":true},"tasks":{"list":{},"cancel":{},"requests":{"tools":{"call":{}}}}}
tools: echo
       list_deployments
       get_deployment
       get_ci_failure
       list_issues
       create_issue
       comment_on_issue
       create_branch [DESTRUCTIVE]
       open_pull_request [DESTRUCTIVE]
       diagnose_incident
```

The `tasks` capability is advertised and `diagnose_incident` is published as a task-capable tool.

### Live task flow (real MCP client, real HTTP)

```
TASK CREATED: 874dfd87fdcef7e9cb3b8a8947e1e6cb working
TASK STATUS: working -
TASK STATUS: completed - Writing the diagnosis…
TASK RESULT: {"id":"inc_3933874758","title":"checkout-api production deployment failed",
 "summary":"rolled out to 1/3 replicas then rolled back","source":"dep_1914063509_1",
 "service":"checkout-api","severity":"high",
 "likelyCause":"test/unit-tests: Tests failed: 3 assertions failed in checkout/cart.spec.ts",
 "recommendedAction":"See issue #412 (\"Checkout total rounds up to the wrong amount\").",
 "evidence":["deployment dep_1914063509_1 (a1c93f2)","ci run run_4821 — unit-tests","issue #412"]}
```

The handle comes back immediately, the status progresses, and the task terminates with a correlated diagnosis.

### Live REST routes

```
$ curl -s http://localhost:8099/api/v1/health
{"status":"ok","server":{"name":"muca-mcp","version":"0.2.0"},
 "mcp":{"protocolVersion":"2025-11-25","url":"http://localhost:8099/api/v1/mcp"},
 "ai":{"enabled":true,"provider":"openai"},"tools":[...9 tools...]}

$ curl -s http://localhost:8099/api/v1/runs
{"runs":[{"id":"run_d2e6...","startedAt":"...","finishedAt":"...",
 "userMessage":"list the recent deployments for checkout-api","text":"",
 "outcome":"error","toolCallCount":0,"approvalCount":0,"taskId":null}]}

$ curl -s -w "HTTP %{http_code}" http://localhost:8099/api/v1/tasks/nope
{"error":"No task with id nope."} HTTP 404

$ curl -s -w "HTTP %{http_code}" http://localhost:8099/api/v1/runs/nope
{"error":"No run with id nope."} HTTP 404
```

(The `outcome: "error"` run is the real one: the repo's `.env` holds a **dummy** OpenAI key, so the provider returns 401. The run is still recorded, with the error in the audit trail.)

### Run history survives a restart

```
# 1. run a chat request        → GET /api/v1/runs shows 1 run
# 2. kill the server, start it again
$ curl -s http://localhost:8099/api/v1/runs
{"runs":[{"id":"run_d2e61eab-86d7-46dc-934c-ba2ec747e2a6", ... }]}   # still there
```

### Frontend still loads

```
$ curl -s -o /dev/null -w "HTTP %{http_code}" http://localhost:8099/
HTTP 200
```

---

## REST contract (for the FRONTEND agent)

Everything is under `/api/v1`. The existing `/health`, `/tools` and `/chat` keep their **exact** response shapes; the only additions are **new fields**, never removals or renames.

### `GET /api/v1/health` — unchanged, plus nothing removed

```jsonc
{
  "status": "ok",
  "server": { "name": "muca-mcp", "version": "0.2.0" },
  "mcp": { "protocolVersion": "2025-11-25", "url": "http://localhost:8099/api/v1/mcp" },
  "ai": { "enabled": true, "provider": "openai" },   // provider is "openai" | "bedrock"
  "tools": [
    { "name": "list_deployments", "title": "…", "description": "…", "destructive": false }
  ]
}
```

`ai.provider` is now `"bedrock"` when `AI_PROVIDER=bedrock`. `ai.enabled` is `false` when the selected provider is not configured.

### `GET /api/v1/tools` — unchanged

```jsonc
{ "tools": [ { "name": "…", "title": "…", "description": "…", "destructive": false,
               "inputSchema": { /* the Zod shape */ } } ] }
```

### `POST /api/v1/chat` — **one new field: `runId`**

Request (unchanged):

```jsonc
{ "message": "…",                                  // required, 1..8000
  "history": [ { "role": "user" | "assistant", "content": "…" } ],  // default []
  "approvedCallIds": ["call_…"] }                 // default []
```

Response — the previous body **plus** `runId`:

```jsonc
{
  "text": "…",
  "awaitingConfirmation": false,
  "pendingCall": null,          // { callId, name, arguments, message } when parked
  "events": [ /* see below */ ],
  "runId": "run_d2e61eab-86d7-46dc-934c-ba2ec747e2a6"   // NEW
}
```

### The `events` array — one new event type: `approval_decision`

All existing event types are **unchanged**: `text`, `tool_call`, `tool_result`,
`confirmation_required`, `error`.

```jsonc
// NEW — the decision the server recorded for a destructive call
{ "type": "approval_decision", "id": "call_…", "name": "create_branch",
  "approved": true, "source": "http" }   // source: "http" | "elicitation" | "fallback"
```

### `GET /api/v1/runs?limit=20`

`limit` is optional, clamped to 1..100, default 20. Newest first.

```jsonc
{ "runs": [
  { "id": "run_…",
    "startedAt": "2026-10-21T10:23:04.125Z",
    "finishedAt": "2026-10-21T10:23:04.979Z",   // null while running
    "userMessage": "list the recent deployments for checkout-api",
    "text": "",
    "outcome": "completed",     // "completed" | "awaiting_approval" | "error" | "cancelled"
    "toolCallCount": 1,
    "approvalCount": 1,
    "taskId": null }            // the MCP task id, when the run started one
] }
```

### `GET /api/v1/runs/:runId`

The **full** record:

```jsonc
{ "run": {
  "id": "run_…",
  "startedAt": "…", "finishedAt": "…",
  "userMessage": "…", "text": "…",
  "outcome": "completed",
  "toolCalls": [
    { "id": "call_1", "name": "list_deployments",
      "arguments": { "service": "checkout-api" },
      "summary": "Found 3 deployment(s)…",   // omitted while the call is in flight
      "error": "…",                          // present only when the call failed
      "at": "2026-10-21T10:23:04.125Z" }
  ],
  "approvals": [
    { "requestId": "call_2", "toolName": "create_branch",
      "decision": "approved",   // "approved" | "rejected" | "timed_out" | "pending"
      "source": "elicitation",  // "http" | "elicitation" | "fallback"
      "at": "…" }
  ],
  "taskId": null,
  "error": null } }
```

404 when the run is unknown: `{ "error": "No run with id run_…." }`

### `GET /api/v1/tasks/:taskId`

```jsonc
{ "task": {
  "taskId": "874dfd87fdcef7e9cb3b8a8947e1e6cb",
  "status": "working",     // "working" | "input_required" | "completed" | "failed" | "cancelled"
  "createdAt": "…",
  "lastUpdatedAt": "…",
  "statusMessage": "Correlating the CI run…",   // optional
  "result": { /* the tool result, once the task completed */ },  // optional
  "error": "…" } }                                // optional, once it failed
```

404 when the task is unknown: `{ "error": "No task with id …." }`

### `GET /api/v1/tasks`

```jsonc
{ "tasks": [ { "taskId": "…", "status": "working", "createdAt": "…", "lastUpdatedAt": "…",
               "statusMessage": "…" } ] }
```

---

## The tool set

The domain is **deployment / CI failure triage for solo developers and small teams**.

| Tool | Destructive | Purpose |
|---|---|---|
| `echo` | no | Connectivity check: the cheapest full round trip (transport → schema validation → handler → result). |
| `list_deployments` | no | Recent deployments for a service, with status, commit and log tail. |
| `get_deployment` | no | One deployment, with its metadata and log tail. |
| `get_ci_failure` | no | The failing CI run: which job, which step, the error, the log excerpt. |
| `list_issues` | no | Open or closed issues, filterable by state. |
| `create_issue` | no | Open a new issue. |
| `comment_on_issue` | no | Add a comment. |
| `create_branch` | **yes** | Create a branch. |
| `open_pull_request` | **yes** | Open a PR. |
| `diagnose_incident` | no | **MCP Task.** Correlates a deployment + its CI run + the matching issue into one diagnosis. Registered via `server.experimental.tasks.registerToolTask`. |

**The placeholder tools are gone:** `create_note`, `list_notes`, `get_note`,
`delete_note`, `clear_notes` and `get_weather` no longer exist. `echo` is kept
because it is the one tool that proves the pipeline end to end for a judge
who wants to check the plumbing before touching the domain — it is labelled as
a connectivity check in its own description.

### The mock adapters

`src/tools/ops/mock.ts` is deterministic by construction:

- a **fixed** seed epoch (`2026-03-14T09:41:00Z`) — no clock is read;
- a **stable FNV-1a hash** of the inputs — no randomness;
- the same input always produces the same output, in this process and in the
  next one.

The data is a believable incident: a production deployment that rolled back
after a readiness-probe failure, the CI run whose unit tests failed, and the
open issue that describes the same bug. `list_deployments`, `get_deployment`
and `get_ci_failure` line up by id, so a real multi-step agent workflow
actually works.

**The swap-in seam** is `OpsAdapters` (`src/tools/ops/types.ts`): one thin
interface per service (`deployments`, `ci`, `issues`, `git`). A real GitHub or
AWS adapter implements the same interface; the tools do not change. This is
*not* a plugin system — it is four small interfaces and one implementation.

---

## Configuration (new env vars)

Add these to the root `.env.example`. **Do not commit a real `.env`.**

| Variable | Default | Required? | Meaning |
|---|---|---|---|
| `AI_PROVIDER` | `openai` | no | `openai` or `bedrock`. Selects the provider. `openai` stays the default so local dev and the tests keep working. |
| `BEDROCK_MODEL_ID` | `""` (empty) | **yes, if `AI_PROVIDER=bedrock`** | The Bedrock model id, e.g. `anthropic.claude-3-5-sonnet-20241022-v2:0`. Never hardcoded in source. When empty, the provider is reported as not configured. |
| `AWS_REGION` | `us-east-1` | no | The AWS region for Bedrock. |
| `RUN_HISTORY_DIR` | `""` (empty) | no | Where the run history is written. Empty → `apps/server/.muca/runs`. A relative path resolves from the repo root. |

**Credentials for Bedrock come from the standard AWS credential chain**
(env vars, shared config, instance role, SSO, …). Nothing is read from `.env`
and no key is hardcoded. `apps/server` gained one dependency:
`@aws-sdk/client-bedrock-runtime`.

---

## Decisions / trade-offs

### 1. Six existing tests were re-pointed at the new tools (justified)

R4 requires replacing the placeholder tools, and six of the original 21 tests
named them literally. The **behaviour under test did not change** — only the
tool the test drives:

| Test | Was | Now |
|---|---|---|
| `agent.test.ts` — catalogue contains | `create_note` | `list_deployments` |
| `agent.test.ts` — parks on a destructive tool | `delete_note` | `create_branch` |
| `agent.test.ts` — runs once approved | `delete_note` | `create_branch` |
| `mcp-protocol.test.ts` — tool list contains | `create_note`, `delete_note` | `list_deployments`, `create_branch` |
| `mcp-protocol.test.ts` — destructive annotation | `delete_note` | `create_branch` |
| `mcp-protocol.test.ts` — state round-trip | `create_note` + `list_notes` | `create_issue` + `list_issues` |

No test was deleted, skipped or weakened. The three original files still
contain 21 tests, and the assertions are equivalent. A test asserting on a
tool that R4 mandates removing cannot survive otherwise.

### 2. The agent no longer *decides* — the gate does

The old loop had `approvedCallIds` inline. Now the agent asks an
`ApprovalGate` and the gate answers. This is what makes R1 possible: the
same loop serves the MCP path (elicitation) and the web path (HTTP) without
knowing which is which.

A side effect: a **refusal** is now a normal outcome, not a crash. The model
is told "the user declined; do not retry" and the run continues.

### 3. A call id alone is not enough for the web approval

The model produces a **fresh call id** on every turn, so matching the
approved id against the next call would never approve anything. Two
mechanisms fix this:

- `PendingApprovalRegistry` remembers the tool each parked call referred to.
  The HTTP gate then approves the **next call to that tool**, and **consumes**
  the approval — so one approval can never authorise two different actions.
- The gate also accepts the exact call id, so a client that replays the same
  id works too.

### 4. A deferred approval is not a rejection

`HttpApprovalGate` is *deferrable*: it can say "nobody has decided yet",
which parks the run with a `pendingCall` — the existing web contract, kept
intact. `DenyAllApprovalGate` refuses. The agent distinguishes them through
the optional `isPending(requestId)` method; a gate that does not implement it
is simply a gate that never defers.

### 5. The MCP server is the elicitation point, and it is per session

`McpHttpHandler` creates a fresh `McpServer` per session (unchanged, and
correct). The `ElicitationApprovalGate` is built **from that instance**, and
the handler exposes `serverForSession(sessionId)` so a caller can reach the
current session's server. There is **no global singleton** and no way for
one session's approval to reach another. The gate lives in `src/ai/` and
depends only on a one-method interface, so the agent layer still imports no
MCP code.

### 6. The task tool uses `taskSupport: 'optional'`

`required` would make `tools/call` without a task parameter an error, which
would break every ordinary MCP client. `optional` means a task-aware client
gets a handle immediately, and a plain client gets a normal blocking call.
Both work.

### 7. The task status vocabulary is the SDK's, not a custom one

The SDK's own words are used: `working`, `input_required`, `completed`,
`failed`, `cancelled`. The task file mentions `queued` / `running` /
`awaiting_input` — those are **not** the SDK's names, and the task says to
use the SDK's. `working` is the closest to "running" and `input_required` is
the closest to "awaiting_input"; both are surfaced in the REST response
unchanged.

### 8. The run history is a file per run, inside the app

One JSON file per run under `apps/server/.muca/runs`, written to a temp file
and renamed (atomic), with writes serialised through one promise chain.
A file-backed store was preferred over DynamoDB per the brief: no AWS
resources, no setup, and it works locally. It is gitignored by
`apps/server/.gitignore`.

### 9. The `ai` config block is now provider-shaped

`config.ai.model` and `config.ai.baseUrl` became `config.ai.openai.{model,baseUrl,apiKey}`
and `config.ai.bedrock.{modelId,region}`, plus `config.ai.provider` and
`config.ai.enabled`. This is internal to `apps/server` — the REST shape of
`/health` is unchanged except that `ai.provider` can now be `"bedrock"`.

### 10. Two pre-existing failures were fixed along the way

`npm run typecheck` and `npm run lint` were **already failing** on the
baseline commit (12 type errors in `tests/api.test.ts`, 1 lint error in
`src/server.ts`). Both are now clean. The coordinator should know the
baseline was not green.

---

## Follow-ups / risks

### For the coordinator

1. **Root `.env.example` needs the four new variables** (see the table
   above). The root file was out of scope and was not edited.
2. **The root `.gitignore` should ignore `.muca/`** as a belt-and-braces
   measure. `apps/server/.gitignore` covers the app-local path, but the
   default is now inside `apps/server`, so the root entry is optional.
   I did not edit the root file.
3. **`apps/web` was not touched.** The REST contract above matches what the
   FRONTEND agent has already written in `apps/web/lib/api.ts` — I checked
   `RunRecord`, `TaskSnapshot`, `RunsResponse` and the `approval_decision`
   event against my implementation, and they line up field for field. The
   frontend's `ChatResponse` also declares an optional `artifacts` field;
   **the backend does not return `artifacts`** (the task did not ask for it),
   so the frontend must treat it as absent. It reads artifact data from
   `tool_result.data` instead, which the backend does return.

### Risks and limitations

- **The SDK's Tasks API is experimental.** It may change without a major
  version bump. The task store, the status vocabulary and the tool
  registration are all isolated in `src/mcp/tasks.ts`, so a future SDK bump
  touches one file.
- **The Bedrock adapter is unit-tested against a stub, never against real
  Bedrock.** The message and tool-use mapping is proven; the wire behaviour
  of a live model is not. A single manual call against a real Bedrock model
  would close that gap.
- **The mock adapters are the only implementation.** The `OpsAdapters`
  interface is the seam, but no real GitHub/AWS adapter exists. That was
  explicitly out of scope.
- **The elicitation path needs the client to open the standalone GET SSE
  stream** before the server can ask it anything. The SDK's own client does
  this automatically. A hand-rolled client that only POSTs will never see
  the elicitation; the gate falls back to HTTP, so the tool still does not
  run unattended, but the UX differs.
- **Elicitation has a 60-second timeout** (`elicitationTimeoutMs`,
  configurable per `McpServerDeps`). A client that does not answer in time
  falls back to the HTTP path, and the audit trail records `timed_out`.
- **The run history is unbounded on disk.** The *listing* is capped at 100,
  but files accumulate. A retention policy (or a size cap) would be worth
  adding before a public demo.
- **The approval registry is in memory.** It dies with the process, which is
  correct (an approval should not outlive the session) but means an approval
  cannot survive a restart.

### Not done (explicitly out of scope)

- No AWS infrastructure, no CDK/SAM, no deployed resources.
- No real GitHub / AWS integration.
- No multi-tenant support, accounts or billing.
- The zod version (`4.6.7`) and the MCP SDK version (`1.32.1`) are
  **unchanged**. The root `overrides` entry is untouched.
- Nothing was committed or pushed.
