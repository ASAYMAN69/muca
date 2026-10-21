# The live agent: WebSocket streaming, SQLite sessions, and a policy engine

> **Before starting:** if this is a fresh session, read `apps/server/AGENT.md`,
> then `AGENTS/BACKEND/README.md`, then **`AGENTS/WS_PROTOCOL.md`** in full,
> then this task. The protocol file is the contract; do not deviate from it.
> The task is self-contained; do not infer from the user chat.

**App:** server
**Assigned by:** coordinator
**Date:** 2026-10-22
**Deadline:** tonight

## Status

Everything committed so far is accepted: the MCP server, the agent loop,
the approval gate, the provider gateway, the tool catalogue. **Do not
rework them.** This task adds a live layer on top and replaces the way
the web client talks to the agent.

**Read `AGENTS/WS_PROTOCOL.md` first.** It is the shared contract with the
FRONTEND agent, who is building against it in parallel. Anything you
invent that is not in that file will not connect.

## What you are building

1. **A WebSocket channel** that streams the agent's run to the browser as
   it happens, with a per-session sequence number and replay, so a
   dropped connection never loses data.
2. **SQLite persistence** in `~/.adh/database/muca.db`, so sessions
   survive a restart and the sidebar has something to list.
3. **A policy engine** that decides whether a tool may run, from the
   user's own policies — not from anything the model says.
4. **Detached prompting**: the agent can ask the user a question and
   wait, with the run parked in the background.
5. **Prompt caching and compaction**, so a long session stays cheap and
   never exceeds the model's input limit.

## Phase A — the database (do this first)

`node:sqlite`'s `DatabaseSync`. **No new dependency for the database.**

- The schema is in `AGENTS/WS_PROTOCOL.md` §7. Create it exactly.
- The path is `~/.adh/database/muca.db`. Create the directory if it is
  missing. **One global database**, not per project.
- Write a small store module per concern (`sessions`, `events`, `runs`,
  `policies`, `requests`), each with typed functions. No ORM, no
  migrations framework — `CREATE TABLE IF NOT EXISTS` at open.
- **The old JSON run history is removed**: delete `src/store/run-history.ts`
  and its test, and remove the `/runs` routes. The database replaces it.
  (Say so in your summary; the coordinator updates the README.)
- Tests must use a temporary database — never the user's real one. The
  store takes the path as a parameter for exactly this reason.

## Phase B — the WebSocket

- `ws` is the one new dependency. Attach it to the **existing** Express
  server on the **existing** port, at `/api/v1/ws`. **No new listener.**
- Implement §1–§5 of the protocol exactly: the envelope, the `seq`
  counter, `hello`, the replay from the in-memory ring buffer (2000
  frames) then from SQLite, then `gap`.
- **Every frame carries a sequence number, and the client can always
  recall what it missed.** That is the point of the whole thing.
- A per-session ring buffer of the last 2000 frames, in memory.
- The socket must not require authentication, and must not read cookies
  or headers to identify the client. It accepts any origin.

## Phase C — provider streaming

The user wants to watch the model think. That means **streaming token by
token** from the provider, which the current adapters do not do.

- Add a streaming method to the `AIProvider` interface
  (`chatStream`), or a sibling interface — your call, but the **agent
  loop** must be able to consume it.
- Implement SSE parsing for **Anthropic** (Messages API streaming:
  `content_block_delta`, `thinking_delta`, `input_json_delta`),
  **OpenAI** (chat completions streaming: `choices[].delta`) and
  **Gemini** (`streamGenerateContent`). Anthropic and OpenAI use
  `text/event-stream`; Gemini uses `:streamGenerateContent?alt=sse`.
- Emit `thinking_delta` for reasoning content, `message_delta` for prose,
  `tool_call_started` when the model asks for a tool.
- **A provider that cannot stream must still work** — fall back to one
  non-streaming call and emit the text as a single delta. Never fail a
  run because a provider will not stream.
- Keep the existing non-streaming `chat` working. The MCP path uses it
  and **must not change**.

## Phase D — the policy engine

This replaces the current "the client sends back the call id" flow for
the web path. The protocol is §8.

- A policy is tool name + optional argument matchers → `allow` / `ask` /
  `deny`. The matcher vocabulary is in §8. Write it carefully; it is
  small.
- **No matching policy** ⇒ ask for a tool that writes, allow for a
  read-only tool. The `writes` axis already exists on the tools.
- The decision is made by the **server**. The model never influences it.
- The permission request is built **from the tool definition** — the
  tool's title, its description, the exact validated arguments, and the
  reason. **Never from the model's prose.** This is the whole point.
- The `matchedPolicy` in the payload names the policy that decided, or is
  `null` for the default.
- **The MCP path keeps its elicitation gate, unchanged.** Policies are
  for the web app. Do not alter MCP behaviour.
- The **existing** approval gate (`src/ai/approval-gate.ts`) and the
  argument-binding fix stay, and `POST /api/v1/chat` keeps working
  exactly as it does now — the old frontend depends on it and the new one
  is being built in parallel. The policy engine is the **new** path.
- `decide` with `remember: true` creates a global policy from the
  decision.

## Phase E — detached prompting

§9. When the model needs an answer from the user, the run **parks** and
the server emits `clarification_requested` with the question. The user
answers over the socket; the answer is appended to the conversation and
the run continues.

- Decide how the model asks. The simplest honest version: the model
  emits a tool call to a built-in `ask_user` tool, and the server turns
  that into a `clarification_requested` event. Add the tool to the
  registry with `writes: false`, `destructive: false`.
- The question's text comes from the model; the **options**, if any, come
  from the tool's arguments. Keep it honest in the UI.
- A parked run does not survive a server restart. Document that.

## Phase F — caching, compaction, and context limits

§10.

- The message list is **append-only**. Nothing reorders it.
- Anthropic gets `cache_control: { type: "ephemeral" }` on the system
  prompt and on the last stable message. OpenAI and Gemini get nothing
  extra.
- **Compaction** when the estimated input tokens pass 0.8 of the model's
  input limit. The summary prompt is adapted from opencode's
  `packages/opencode/src/agent/prompt/compaction.txt` (MIT — put the
  attribution in the file header), narrowed to ops triage: deployments,
  CI runs, issues, decisions, and what the user asked for.
- Compaction keeps the last 3 turns verbatim, all tool call/result pairs,
  the pending approval and request state, and **every deployment id, CI
  run id and issue number already seen**. Losing an id loses the trail.
- **Context limits**: a per-provider table in config, refreshed from the
  provider's own models endpoint when it publishes the number (Gemini's
  `/v1beta/models` returns `inputTokenLimit`; OpenAI and Anthropic do
  not), with a documented fallback per provider and model family. Read
  the limit at startup and cache it; never block the boot on it.

## Phase G — the REST additions

§11. Additive only. `GET /api/v1/tools` and `POST /api/v1/chat` keep
their current shapes exactly.

## Rules

- **Stay inside `apps/server`.** The FRONTEND agent is editing
  `apps/web` right now. Never touch it, and never touch
  `AGENTS/FRONTEND/`.
- **Do not change `AGENTS/WS_PROTOCOL.md`.** If it is wrong or missing
  something, say so in `SUMMARY.md` and pick the closest behaviour, and
  flag it loudly.
- **Do not change the MCP endpoint** or the tool catalogue's meaning.
- **Do not commit or push.**
- **Do not weaken the existing tests.** All 260 must still pass. The
  `/runs` routes are being removed — that is the one deletion, and it
  comes with its test.
- Zod stays `4.6.7`. The MCP SDK stays `1.32.1`. `node:sqlite` and `ws`
  are the only additions.
- No other new dependencies. No ORM, no migration tool, no state library.
- Keys are never logged, never in a URL, never in an error message.
- **One port.** The socket is on the existing server, on the existing port.

## Acceptance criteria

- [ ] The database is at `~/.adh/database/muca.db` with the exact schema
      in §7, and the old JSON run history is gone.
- [ ] The socket is at `/api/v1/ws` on the existing port, and a browser
      connects to it.
- [ ] Every frame carries a strictly increasing `seq`; a client that
      reconnects with `lastSeq` receives **every** frame it missed, or a
      `gap` — never a silent skip. Proven by a test that drops frames.
- [ ] A run streams: `thinking_delta` / `message_delta` /
      `tool_call_started` / `tool_call_completed` / `run_finished`, in
      order, with no gaps.
- [ ] The two paths hold: the run buffer is written to SQLite **only**
      when the run finishes, and the frontend saw the events live.
- [ ] A policy with `allow` runs the tool without asking; `deny` refuses
      it and says why; `ask` parks and shows the request built from the
      **tool definition**.
- [ ] A tool with no policy is asked about if it writes, and allowed if
      it does not.
- [ ] The model cannot influence a decision: a tool call whose arguments
      differ from the approved one is refused, exactly as today.
- [ ] A parked run survives a reconnect: the client sees the pending
      permission and the decision reaches the run.
- [ ] The agent can ask the user a question mid-run, and the run
      continues when the answer arrives.
- [ ] A long session compacts, and the summary keeps the ids.
- [ ] The Anthropic request carries `cache_control`; OpenAI and Gemini
      do not.
- [ ] `npm test --workspace @muca/server` passes, `npm run typecheck`
      and `npm run lint` are clean.

## Verification

```bash
npm test --workspace @muca/server
npm run typecheck --workspace @muca/server
npm run lint --workspace @muca/server
```

Then, live, on a port of your own (**not 8099** — the coordinator is
using it):

```bash
cd apps/server && PORT=8093 npx tsx src/index.ts
```

- Connect a socket, run a chat, and show the frames arriving **while the
  run is in progress** — paste the raw frames into `SUMMARY.md`.
- Kill the socket mid-run, reconnect with `lastSeq`, and paste the
  replayed frames.
- Show the database: `sqlite3 ~/.adh/database/muca.db` is not installed
  — use `node -e` with `node:sqlite` to print the tables and the event
  rows.
- Show a policy being created, then a run that obeys it.

## Out of scope

- The frontend.
- The MCP endpoint's behaviour.
- A settings UI (the FRONTEND agent builds it; you build the API).
- Anything not in `AGENTS/WS_PROTOCOL.md`.
