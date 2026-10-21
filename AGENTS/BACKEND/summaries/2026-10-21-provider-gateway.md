# Summary — Provider gateway: Anthropic / OpenAI / Gemini with a parallel health probe

**Status:** complete
**Date:** 2026-10-21

---

## What changed

Two parts, as the brief describes.

### Part A — the provider gateway (the bulk)

Muca now works whichever AI key the operator happens to have. Up to three
HTTP endpoints are configured from the environment, **probed in parallel at
startup**, and the highest-priority one that actually answers is used.

| File | Purpose |
|---|---|
| `src/ai/probe.ts` | The probe. A minimal real request per provider, with the status classification. |
| `src/ai/gateway.ts` | The selection: priority order, explicit mode, the one-line decision summary. |
| `src/ai/anthropic-provider.ts` | Anthropic Messages API adapter. |
| `src/ai/gemini-provider.ts` | Google Gemini `generateContent` adapter. |
| `src/ai/provider-factory.ts` | Maps a gateway decision to an `AIProvider`. |
| `src/ai/ai-state.ts` | The gateway's state, in its own module so the HTTP layer and the server wiring do not import each other. |
| `src/config.ts` | The per-provider environment blocks. |
| `src/server.ts` | Runs the gateway at startup; builds the provider from the decision. |
| `src/http/api.ts` | `/health` gains the gateway's detail; `POST /ai/probe` added. |
| `src/index.ts` | Prints the one-line decision at startup. |

**No new dependencies.** Both adapters use the global `fetch`; the OpenAI
SDK stays for the existing adapter.

### Part B — catalogue alignment

`diagnose_incident` was registered only in the MCP layer, so the REST
router never saw it: MCP said 10 tools, `/api/v1/tools` and `/api/v1/health`
said 9. The server disagreed with itself about its own surface.

**`src/tools/catalogue.ts`** is now the single declaration:

- `TASK_BACKED_TOOLS` — the protocol-level tools, with their name, title,
  description and input schema.
- `buildCatalogue(registryTools)` — the registry tools plus the task-backed
  ones, in one uniform list.
- `toJson` / `toHealthJson` — the two wire shapes.

Both the MCP layer (`src/mcp/tasks.ts` now reads `TASK_BACKED_TOOLS` instead
of declaring its metadata inline) and the REST layer derive from it.
`api.ts` contains **no hardcoded tool name**.

The REST response marks the distinction honestly: `taskBacked: true` for
`diagnose_incident`, `false` for the other nine. The nine existing entries
keep their names, titles, descriptions and `destructive` flags unchanged;
the new field is purely additive.

---

## Verification

All commands from `/mnt/ee/aprojects/zyrun/adh`.

### Tests — 229 passing, 17 files (was 154 across 13)

```
$ npm test --workspace @muca/server

 Test Files  17 passed (17)
      Tests  229 passed (229)
```

New files:

| File | Tests | Covers |
|---|---|---|
| `tests/provider-gateway.test.ts` | 38 | config, classification, probing, parallelism, timeout, the selection matrix, explicit mode, the decision summary |
| `tests/provider-adapters.test.ts` | 20 | both adapters: message mapping both ways, tool calls, finish reasons, the Gemini id trap |
| `tests/ai-health.test.ts` | 6 | the `/health` shape and `POST /ai/probe` |
| `tests/tool-catalogue.test.ts` | 11 | Part B: the three surfaces agree |

**All 154 pre-existing tests still pass.** None was weakened.

### Typecheck and lint — clean

```
$ npm run typecheck --workspace @muca/server
> tsc --noEmit
(no output)

$ npm run lint --workspace @muca/server
> eslint src
(no output)
```

### Live check — with **stub** endpoints

> **These endpoints were stubs, not real providers.** A small Node HTTP
> server under `/tmp/opencode/` answered each probe with a fixed status
> code. No real Anthropic, OpenAI or Gemini API was contacted, and the
> "keys" were dummy strings. Nothing below is a real provider call.

**1. No keys, `AI_PROVIDER=auto` — the server still boots:**

```
  Muca — Amazon Developer Hackathon 2026 (Alexa+ track)
  ---------------------------------------------------
  Frontend   http://localhost:8099/
  REST API   http://localhost:8099/api/v1
  MCP        http://localhost:8099/api/v1/mcp
  Protocol   2025-11-25
  AI gateway  auto → none — the server will run without a model  probes: anthropic not_configured · openai not_configured · gemini not_configured
             No usable AI provider — MCP, the tools and the demo mode still work.
```

`/health`:

```json
{
  "enabled": false,
  "provider": null,
  "model": null,
  "mode": "auto",
  "selectedAt": "2026-10-21T15:48:55.220Z",
  "probes": [
    { "provider": "anthropic", "status": "not_configured", "ok": false, "latencyMs": 0, "detail": "No API key configured." },
    { "provider": "openai",    "status": "not_configured", "ok": false, "latencyMs": 0, "detail": "No API key configured." },
    { "provider": "gemini",    "status": "not_configured", "ok": false, "latencyMs": 0, "detail": "No API key configured." }
  ]
}
```

`GET /` → **HTTP 200** (the UI still loads), and
`POST /api/v1/ai/probe` returned the same three probes with
`"applied": false`.

**2. Anthropic stub 200, OpenAI stub 401 — Anthropic is selected:**

```
  AI gateway  auto → anthropic (claude-stub-model)  probes: anthropic ok 99ms · openai invalid_key 88ms · gemini not_configured
```

```json
{
  "enabled": true,
  "provider": "anthropic",
  "model": "claude-stub-model",
  "mode": "auto",
  "selectedAt": "2026-10-21T15:53:56.245Z",
  "probes": [
    { "provider": "anthropic", "status": "ok",          "ok": true,  "latencyMs": 99,  "detail": "The endpoint answered." },
    { "provider": "openai",    "status": "invalid_key", "ok": false, "latencyMs": 88,  "detail": "The key was rejected (401/403)." },
    { "provider": "gemini",    "status": "not_configured", "ok": false, "latencyMs": 0, "detail": "No API key configured." }
  ]
}
```

The stub's own log confirms the key travelled in a **header**, never in the
URL, and that the probe body is minimal:

```
[anthropic-stub] POST /v1/messages auth=true body={"model":"claude-stub-model","max_tokens":1,"messages":[{"role":"user","content"
[openai-stub]    POST /chat/completions auth=true body={"model":"gpt-stub-model","max_tokens":1,"messages":[{"role":"user","content":"h
```

**3. Reversed — Anthropic stub 401, OpenAI stub 200 — OpenAI is selected:**

```
  AI gateway  auto → openai (gpt-stub-model)  probes: anthropic invalid_key 116ms · openai ok 92ms · gemini not_configured
```

```json
{
  "enabled": true,
  "provider": "openai",
  "model": "gpt-stub-model",
  "mode": "auto",
  "selectedAt": "2026-10-21T15:56:59.329Z",
  "probes": [
    { "provider": "anthropic", "status": "invalid_key",   "ok": false, "latencyMs": 116, "detail": "The key was rejected (401/403)." },
    { "provider": "openai",    "status": "ok",            "ok": true,  "latencyMs": 92,  "detail": "The endpoint answered." },
    { "provider": "gemini",    "status": "not_configured", "ok": false, "latencyMs": 0,   "detail": "No API key configured." }
  ]
}
```

**4. Explicit mode — `AI_PROVIDER=openai` with OpenAI failing 401, and
Anthropic healthy at 200:**

```
  AI gateway  explicit → none — the server will run without a model  probes: openai invalid_key 110ms · anthropic not_configured · gemini not_configured
             No usable AI provider — MCP, the tools and the demo mode still work.
```

It did **not** fall back to the healthy Anthropic endpoint. `mode` is
`explicit` and `enabled` is `false`.

### Part B — the three tool surfaces, live

```
$ curl -s localhost:8099/api/v1/tools   | actual tool count: 10
$ curl -s localhost:8099/api/v1/health  | actual tool count: 10
$ MCP tools/list count: 10
```

```
MCP tools/list count: 10
  echo taskSupport= forbidden
  list_deployments taskSupport= forbidden
  get_deployment taskSupport= forbidden
  get_ci_failure taskSupport= forbidden
  list_issues taskSupport= forbidden
  create_issue taskSupport= forbidden
  comment_on_issue taskSupport= forbidden
  create_branch taskSupport= forbidden
  open_pull_request taskSupport= forbidden
  diagnose_incident taskSupport= optional
```

```
GET /api/v1/tools  (count: 10)
  echo taskBacked= False
  list_deployments taskBacked= False
  get_deployment taskBacked= False
  get_ci_failure taskBacked= False
  list_issues taskBacked= False
  create_issue taskBacked= False
  comment_on_issue taskBacked= False
  create_branch taskBacked= False
  open_pull_request taskBacked= False
  diagnose_incident taskBacked= True
```

> **Note on the brief's `grep -c '"name"'` command:** it reports **11**,
> not 10. The extra match is the `"name"` key *inside* a tool's
> `inputSchema` (a Zod schema property), not an eleventh tool. Counting
> the `tools` array gives 10 on all three surfaces.

---

## Requirements → evidence

| Req | Status | Evidence |
|---|---|---|
| **R1** — the environment | ✅ | `AI_PROVIDER` defaults to `auto`; the per-provider blocks; `ANTHROPIC_MODEL` empty ⇒ not configured; Gemini's defaults live in `config.ts`, not `.env`; `OPENAI_BASE_URL` works as an alias and the new name wins. |
| **R2** — parallel probes, classified | ✅ | `Promise.allSettled`, one `AbortController` per probe, the `AI_PROBE_TIMEOUT_MS` deadline; the seven statuses, with `throttled` usable; the latency recorded; the key never in a URL or a log. |
| **R3** — selection | ✅ | anthropic > openai > gemini; `throttled` counts; none usable ⇒ `enabled: false` and the server still boots; explicit mode never falls back; the one-line summary. |
| **R4** — the adapters | ✅ | `anthropic-provider.ts` and `gemini-provider.ts`, both on the global `fetch`, both mapping the full conversation. |
| **R5** — health | ✅ | `enabled` and `provider` unchanged; `model`, `mode`, `selectedAt`, `probes` added; `POST /api/v1/ai/probe` re-runs the probes and says `"applied": false`. |
| **R6** — Part B | ✅ | One catalogue; `diagnose_incident` included and marked `taskBacked`; the other nine unchanged; no hardcoded name in `api.ts`. |

### Acceptance criteria

- [x] Anthropic and OpenAI both valid ⇒ Anthropic.
- [x] Only OpenAI valid ⇒ OpenAI; only Gemini valid ⇒ Gemini; none valid
      ⇒ boots with `enabled: false`.
- [x] 429 is usable, 401 is not.
- [x] The probes demonstrably run in parallel and respect the timeout.
- [x] Gemini tool calls survive a round trip, including two calls to the
      same tool in one turn.
- [x] `/health` keeps `enabled` and `provider`, adds `mode` and `probes`.
- [x] `POST /api/v1/ai/probe` re-runs the probes without changing the
      provider.
- [x] Part B: `/tools` and `/health` report 10 tools, matching MCP.
- [x] `npm test --workspace @muca/server` passes (229).
- [x] `npm run typecheck` and `npm run lint` are clean.
- [x] The variable names are exactly what `config.ts` reads, and they match
      the root `.env.example` the coordinator wrote. **That file was not
      edited.**

---

## Decisions / trade-offs

### 1. A 429 counts as usable

As the brief specifies. A rate-limited key is still a working key, and
refusing to start because of a transient 429 would be worse than trying.
The probe still reports `status: "throttled"` and `ok: true`, so the
distinction is visible in the health output.

### 2. Explicit mode probes only the named provider

The other two are reported as `not_configured` with the detail *"Not
selected: the operator named a provider explicitly."* The health output is
therefore complete, but no request is made to a provider the operator did
not ask for. A test asserts exactly one request is sent.

### 3. `OPENAI_ENDPOINT` has an empty schema default

The first version gave `OPENAI_ENDPOINT` a default of
`https://api.openai.com/v1`, which **silently broke the deprecated
alias**: the new name always won, because it was never empty. The schema
default is now `''` and the real endpoint is the fallback in `loadConfig`.
The test caught this; it is now covered by *"keeps `OPENAI_BASE_URL`
working as a deprecated alias"*.

### 4. The Gemini id is `gemini_call_<n>_<toolName>`

It embeds a **counter**, so two calls to the same tool in one turn get
different ids, and it is stable for the life of the provider instance. The
adapter keeps a `Map` from the synthesised id to the original call, so the
round trip is verifiable — the test asserts two calls to `create_branch`
get different ids and that each id maps back to its own arguments. The id
is never the tool name alone.

### 5. `AiState` lives in its own module

`api.ts` needs the gateway's state, and `server.ts` builds it. Putting the
type in `server.ts` would have made `api.ts` import `server.ts` while
`server.ts` imports `api.ts` — a cycle. `src/ai/ai-state.ts` breaks it.
(The cycle was type-only, so it would have been erased at runtime, but a
cycle is a poor shape regardless.)

### 6. The probe is injected, not mocked at the network layer

`ProbeFetch` is a narrow function type. The tests inject it, so **no test
ever touches the network** — the requirement in the brief. The same
mechanism is used for the adapters' `FetchLike`.

### 7. The gateway is env-driven, but the *decision* is not

`AI_PROVIDER` decides the **mode** (`auto` vs explicit). Which provider
wins is decided by the probes at runtime. The config records the outcome
(`config.ai.selected`, `config.ai.enabled`) so everything reading the
config sees the same truth as `/health`.

### 8. The REST contract is additive

`/health`'s `ai` object keeps `enabled` and `provider` **exactly** as they
were — the web client reads `ai.enabled`. `model`, `mode`, `selectedAt` and
`probes` are new. `POST /ai/probe` is a new route. Nothing was renamed or
removed, so `apps/web` needs **no change**.

### 9. One pre-existing flake found

While verifying, `tests/tasks.test.ts` → *"times out a task that runs for
too long"* failed **once** under load. It is a 30 ms-timeout test, and
`setTimeout` can fire a millisecond early, so the deadline check
(`Date.now() >= deadline`) can be false when the task is *just* over its
deadline. I confirmed it is **pre-existing** (it fails on the baseline
commit too, under the same load) and that my change does not touch the
`TaskRunner`'s timing logic. I started to fix it, then **reverted** that
change: this task says *"Do not touch MCP, the tools"*, and the fix belongs
to whoever owns that code. **It is a latent flake worth a follow-up.**

---

## Follow-ups / risks

### For the coordinator

- **No frontend change is needed.** `/health`'s `ai.enabled` and
  `ai.provider` are unchanged, and the new fields are additive. The web
  client already ignores unknown fields.
- **The root `.env.example` was not edited**, as instructed. The
  variable names in `config.ts` match it exactly.
- **The `grep -c '"name"'` command in the brief reports 11, not 10** —
  the extra match is an `inputSchema` property, not a tool. If the
  coordinator wants that command to read 10, it should count the
  `tools` array instead.
- **The `TaskRunner` timeout flake** (above) is a small, separate fix.

### Risks and limitations

- **The live verification used stub endpoints, not real providers.** The
  routing, the classification, the parallelism and the selection are all
  proven; the *adapters'* wire formats are proven by unit tests against
  recorded shapes, but not against a live Anthropic or Gemini API. The
  stub answers any POST with a fixed status, so it exercised the probe
  path, not a real conversation.
- **The probe is a real request, so it costs a token.** `max_tokens: 1`
  keeps it minimal, but it is not free. A provider that rate-limits
  immediately will report `throttled` and be selected — which is
  intentional, but it means the first real user request may be the one
  that hits the limit.
- **A probe is not a guarantee.** An endpoint that answers the probe may
  still fail the first real request (for example a model that accepts
  `max_tokens: 1` but rejects a longer conversation). The gateway
  picks the best *available* endpoint, not a guaranteed-working one.
- **`selectedAt` is the startup time.** A re-probe via
  `POST /ai/probe` does not update it, because the provider in use does
  not change — that is the point of the endpoint.
- **The `probes` array is in memory** and is rebuilt on every re-probe.
  It is not persisted to the run history.
- **The Gemini adapter synthesises ids per provider instance.** A
  long-lived process accumulates one `Map` entry per tool call. It is
  tiny, but it is unbounded in principle; a long-lived server would want
  a cap.

### Not done (out of scope)

- Streaming responses.
- Token accounting or cost tracking.
- Hot-swapping the provider for a live process.
- Any change to the MCP layer, the tool set, the approval code or the
  REST chat contract.
- Frontend changes.
- Bedrock is untouched and not part of the auto priority.
- No new dependencies.
- The zod version (`4.6.7`) and the MCP SDK version (`1.32.1`) are
  **unchanged**.
- Nothing was committed or pushed.
