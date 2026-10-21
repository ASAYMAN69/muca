# Provider gateway: Anthropic / OpenAI / Gemini with a parallel health probe

> **Before starting:** if this is a fresh session, read `apps/server/AGENT.md`,
> then `AGENTS/BACKEND/README.md`, then this task. The task is self-contained;
> do not infer from the user chat.

**App:** server
**Assigned by:** coordinator
**Date:** 2026-10-21

## Status

The approval fix and the previous rounds are committed and accepted — **do
not revisit them**.

This task has two parts:

- **Part A (the bulk):** a provider gateway that picks the best available AI
  endpoint at startup. **This is new work.**
- **Part B (small):** align the REST tool catalogue with what MCP advertises
  — the 9-vs-10 mismatch. **Unchanged from the brief you already have;** do
  it after Part A, it is independent.

## Goal

Muca should work whichever AI key the operator happens to have. Instead of
one hardcoded provider, the server configures up to three HTTP endpoints
from the environment, **probes them in parallel at startup**, and uses the
highest-priority one that actually answers.

This is only the **I/O gateway to the model**: prompt in, answer out. It
does not touch MCP, tools, the agent loop's semantics, or approval.

## R1 — Environment

Add a per-provider block. Names are exact; the operator asked for this
shape.

```bash
# --- Provider selection -------------------------------------------------
# auto | anthropic | openai | gemini | bedrock
# auto: probe all configured endpoints in parallel and pick the highest
#       priority that answers (anthropic > openai > gemini).
AI_PROVIDER=auto
# How long a single probe may take before it counts as failed.
AI_PROBE_TIMEOUT_MS=4000

# --- Anthropic ----------------------------------------------------------
ANTHROPIC_API_KEY=
ANTHROPIC_ENDPOINT=https://api.anthropic.com
ANTHROPIC_MODEL=

# --- OpenAI (and OpenAI-compatible) -------------------------------------
OPENAI_API_KEY=
OPENAI_ENDPOINT=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini

# --- Google Gemini ------------------------------------------------------
# Only the key is configured; endpoint and model have working defaults.
GEMINI_API_KEY=
```

Rules:

- `AI_PROVIDER` **defaults to `auto`** in the schema (it currently defaults
  to `openai`).
- `ANTHROPIC_MODEL` empty means "Anthropic is not configured". There is no
  safe default model id — the operator must name one.
- `GEMINI_ENDPOINT` and `GEMINI_MODEL` are **not** required in `.env`; give
  them defaults in `config.ts` (`https://generativelanguage.googleapis.com/v1beta`
  and a current flash model). They may still be overridable — just do not
  put them in `.env.example`, because the operator only has the key.
- `OPENAI_BASE_URL` is the old name for `OPENAI_ENDPOINT`. Keep it working
  as a deprecated alias (new name wins when both are set). Do not break an
  existing `.env`.
- A provider is **configured** when it has both a key and, for Anthropic,
  a model. No key ⇒ not configured ⇒ never probed, never selected.
- `AI_PROVIDER=bedrock` keeps working exactly as it does today and is **not**
  part of the auto priority.

## R2 — Probe them in parallel

Write `src/ai/probe.ts` (name it as you see fit). For every **configured**
provider, send a **minimal real request** concurrently:

- Anthropic: `POST {ANTHROPIC_ENDPOINT}/v1/messages`, `max_tokens: 1`,
  one short user message.
- OpenAI: `POST {OPENAI_ENDPOINT}/chat/completions`, `max_tokens: 1`.
- Gemini: `POST {GEMINI_ENDPOINT}/models/{model}:generateContent`, generate
  content config with `maxOutputTokens: 1`.

The probes must start **before any of them is awaited** — use
`Promise.allSettled`, one `AbortController` per probe, and the
`AI_PROBE_TIMEOUT_MS` deadline. Never let one slow provider delay the
others, and never let a probe hang the boot.

### Classify the answer — this is the "intelligent" part

Do not reduce the result to a boolean. Return a status per provider:

| Status | When | Counts as usable? |
|---|---|---|
| `ok` | 2xx with a parseable body | **yes** |
| `throttled` | 429 | **yes** — the key is valid, it is just rate-limited |
| `invalid_key` | 401, 403 | no |
| `bad_request` | other 4xx (bad model id, wrong endpoint path) | no |
| `unreachable` | network error / DNS / connection refused | no |
| `timeout` | aborted at the deadline | no |
| `not_configured` | no key (or no model, for Anthropic) | no |

`throttled` counting as usable is deliberate: a rate-limited key is still a
working key, and refusing to start because of a transient 429 would be worse
than trying. Record the latency in ms for each probe.

Never log a key. Never put a key in a URL query string — use the
`x-api-key` / `x-goog-api-key` headers.

## R3 — Selection

```
configured providers, in priority order: anthropic, openai, gemini
  └─ probes run in parallel; results settle independently
     └─ the first provider in priority order whose status is usable wins
```

- Both Anthropic and OpenAI usable ⇒ **Anthropic**.
- Only one usable ⇒ that one.
- Only Gemini usable ⇒ **Gemini**.
- **None usable ⇒ `enabled: false`.** The server must still boot: MCP, the
  tools and the demo mode all work without a model. Say why in the log and
  in `/health`. (Gemini is the lowest priority, not an unconditional
  fallback — selecting a provider that failed its probe would just move the
  failure to the first user message.)
- `AI_PROVIDER=<name>` (not `auto`) means "use this one, no selection":
  still probe it so the health output is honest, but if it is not usable,
  set `enabled: false` and log loudly rather than silently switching to a
  different provider. Predictability beats cleverness when the operator has
  been explicit.

Report a decision summary at startup, one line, e.g.:

```
AI gateway  auto → anthropic (claude-…)  probes: anthropic ok 412ms · openai ok 890ms · gemini not_configured
```

## R4 — Adapters

Two new adapters implementing the existing `AIProvider` interface:

- `src/ai/anthropic-provider.ts` — Messages API.
- `src/ai/gemini-provider.ts` — `generateContent`.

Both must map the full conversation, not just a single prompt:

- system message → Anthropic top-level `system` / Gemini `systemInstruction`;
- assistant tool calls → `tool_use` blocks / `functionCall` parts;
- tool results → `tool_result` blocks / `functionResponse` parts;
- provider finish reasons → the existing `ProviderResponse['finishReason']`
  union.

**Gemini trap:** `functionCall` has no call id. The agent loop matches a
tool result back to a call **by id**, so the adapter must synthesise a
stable, unique id per call and map it back when building
`functionResponse`. Do not reuse a constant, and do not use the tool name
as the id — the same tool may be called twice in one turn. Cover this with
a test.

Use the global `fetch` (Node 20+). **Do not add the Anthropic or Google
SDKs.** The OpenAI SDK stays for the existing adapter; you do not have to
migrate it.

## R5 — Health

Extend `GET /api/v1/health`'s `ai` object. **Keep `enabled` and `provider`
exactly as they are** — the web client reads `ai.enabled`.

```jsonc
"ai": {
  "enabled": true,
  "provider": "anthropic",           // unchanged
  "model": "claude-…",
  "mode": "auto",                    // auto | explicit
  "selectedAt": "2026-10-21T…",
  "probes": [
    { "provider": "anthropic", "status": "ok",          "ok": true,  "latencyMs": 412 },
    { "provider": "openai",    "status": "ok",          "ok": true,  "latencyMs": 890 },
    { "provider": "gemini",    "status": "not_configured", "ok": false }
  ]
}
```

Add `POST /api/v1/ai/probe` that re-runs the probes and returns the same
shape **without** changing the provider already in use for this process —
it is a diagnostic, not a hot-swap. Say so in the response
(`"applied": false`). This is what makes the routing visible in a demo.

## R6 — Part B: catalogue alignment

Unchanged from the previous brief. `GET /api/v1/tools` and `/health` report
**9** tools; MCP `tools/list` reports **10** (`diagnose_incident` is
registered only in the MCP layer). One source of truth, `diagnose_incident`
included and marked task-backed, names and annotations of the other nine
unchanged. Do not hardcode the name in `api.ts`.

## Tests

All tests must run **offline**. Inject the fetch/probe function; never hit
a real endpoint in the suite.

- Selection matrix: both usable ⇒ anthropic; only openai ⇒ openai; only
  gemini ⇒ gemini; none ⇒ `enabled: false`; `throttled` counts as usable;
  `invalid_key` does not.
- **Parallelism:** all configured probes are started before any resolves
  (resolve them out of order and assert the earliest-started settles first).
- Timeout: a provider that never answers is `timeout` and does not block
  the others.
- Explicit mode: `AI_PROVIDER=openai` with a failing OpenAI probe yields
  `enabled: false` and does **not** fall back to Anthropic.
- Not configured: no key ⇒ `not_configured`, no request sent.
- Adapters: message mapping in both directions, tool-call extraction,
  finish reasons; the Gemini id-synthesis trap including two calls to the
  same tool in one turn.
- Config: `OPENAI_BASE_URL` still works as an alias; the new names win.
- Health: the documented shape, and `/health` still reports `enabled` and
  `provider` for the web client.
- `/api/v1/ai/probe` returns results and does not change the active
  provider.

## Constraints

- **Stay inside `apps/server`.** Do not edit `apps/web`; the web client
  already degrades correctly when `ai.enabled` is false and ignores unknown
  fields.
- **Do not touch MCP, the tools, the approval code, or the REST chat
  contract.**
- **No new dependencies.** Global `fetch` only.
- **Do not commit or push.**
- **Do not weaken existing tests.** All 154 must still pass.
- Zod stays `4.6.7`; MCP SDK stays `1.32.1`.
- Keys are never logged, never in a URL, never in an error message.

## Acceptance criteria

- [ ] With Anthropic and OpenAI both valid, the server selects Anthropic.
- [ ] With only OpenAI valid, it selects OpenAI; with only Gemini valid, it
      selects Gemini; with none valid it boots with `enabled: false`.
- [ ] A 429 is treated as usable, a 401 is not.
- [ ] The probes demonstrably run in parallel and respect the timeout.
- [ ] Gemini tool calls survive a round trip through the agent loop,
      including two calls to the same tool in one turn.
- [ ] `GET /api/v1/health` keeps `enabled` and `provider` and adds `mode`
      and `probes`.
- [ ] `POST /api/v1/ai/probe` re-runs probes without changing the provider.
- [ ] Part B: `/tools` and `/health` report 10 tools, matching MCP.
- [ ] `npm test --workspace @muca/server` passes.
- [ ] `npm run typecheck --workspace @muca/server` and
      `npm run lint --workspace @muca/server` are clean.
- [ ] The variable names above are exactly what `config.ts` reads. The
      coordinator has already written them into the root `.env.example`;
      **do not edit that file**, it is outside `apps/server`.

## Verification

```bash
npm test --workspace @muca/server
npm run typecheck --workspace @muca/server
npm run lint --workspace @muca/server
```

Then a live check with **no real keys** (this sandbox has none):

1. Start with an empty `AI_PROVIDER=auto` and no keys. Boot must succeed,
   the log must say all three are `not_configured`, and `/health` must show
   `enabled: false`. Confirm the UI still loads and the demo still runs.
2. Point `ANTHROPIC_ENDPOINT` at a tiny stub server on `127.0.0.1`
   (outside the repo, under `/tmp/opencode/`) that returns 200, and
   `OPENAI_ENDPOINT` at one that returns 401. Confirm the log selects
   Anthropic and that `/health` shows `anthropic ok` and
   `openai invalid_key`.
3. Reverse it: Anthropic 401, OpenAI 200 ⇒ OpenAI is selected.

Paste the three logs and the `/health` JSON into `SUMMARY.md`. State
clearly that the endpoints were stubs, so nobody mistakes it for a real
provider call.

## Out of scope

- Streaming responses.
- Token accounting or cost tracking.
- Hot-swapping the provider for a live process.
- Any change to the MCP layer or the tool set.
- Frontend changes.
- Bedrock (it keeps working as-is; not part of auto).
