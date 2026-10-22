# Muca live protocol — the shared contract

**This file is the single source of truth for the BACKEND and FRONTEND
agents.** Both work in parallel against it. Neither may change it without
the coordinator; if something here is wrong or missing, say so in your
summary and **do not** invent a different shape.

Everything below is additive: the existing REST contract keeps working,
and the MCP endpoint is untouched.

---

## 1. The socket

```
ws://<host>:<port>/api/v1/ws?session=<sessionId>&lastSeq=<n>
```

- One socket **per session**. The browser opens one for the session it is
  showing and closes it when the session changes.
- `lastSeq` is optional. It is the last sequence number the client
  already has.
- The server sends a `hello` frame first (see §3), so the client can
  confirm the session and the next sequence to expect.
- No authentication, no token. The socket accepts any origin, like the
  rest of the app. The server must not read cookies or headers to
  identify the client.

## 2. The envelope

Every server→client frame is one JSON object:

```jsonc
{
  "seq": 128,              // per-session, strictly increasing, never reused
  "sessionId": "ses_…",
  "runId": "run_…",        // null for session-level events
  "ts": "2026-10-22T09:14:22.401Z",
  "type": "tool_call_started",
  "data": { … }            // type-specific payload
}
```

- `seq` starts at 1 for a session and increases by exactly 1 per frame.
  A gap means the client missed frames and must ask for them.
- The client tracks `lastSeq`. It never assumes continuity.

## 3. Server → client frames

| `type` | `data` | When |
|---|---|---|
| `hello` | `{ nextSeq, session, serverTime }` | Immediately on connect |
| `run_started` | `{ message, provider, model }` | A run begins |
| `thinking_delta` | `{ text }` | Model reasoning, token by token |
| `message_delta` | `{ text }` | Model prose, token by token |
| `message_complete` | `{ text }` | The model's final text for this turn |
| `tool_call_started` | `{ callId, name, arguments }` | The model asked for a tool |
| `tool_call_completed` | `{ callId, name, summary, data, ok }` | The tool finished |
| `permission_requested` | `{ requestId, toolCallId, tool, title, description, arguments, reason, matchedPolicy }` | A tool needs a decision — **the run is parked** |
| `permission_resolved` | `{ requestId, decision, policyId? }` | The user decided |
| `clarification_requested` | `{ requestId, question, options? }` | The agent needs an answer — **the run is parked** |
| `clarification_answered` | `{ requestId, answer }` | The user answered |
| `run_finished` | `{ outcome, toolCallCount, approvalCount, durationMs }` | The run ended |
| `run_error` | `{ message }` | The run failed |
| `gap` | `{ from, to, reason }` | Frames are missing and cannot be replayed |
| `replayed` | `{ from, to }` | Informational: a replay is being sent |
| `pong` | `{}` | Reply to a `ping` |

`permission_requested.data` is built **from the tool definition**, never
from the model's prose:

- `tool` — the tool name.
- `title` — the tool's human title.
- `description` — the tool's own description.
- `arguments` — the exact, validated arguments that would run.
- `reason` — why it is being asked: `"no policy matched, and this tool writes"`, or `"policy 'fix/* branches' asks"`.
- `matchedPolicy` — the policy that produced the decision, or `null`.
- `toolCallId` — the model's tool call this permission belongs to, so the
  client can put the decision on the right row instead of guessing.
  **Correlation only.** The `requestId` is what authorises the call; this
  id is never accepted as an authorisation token, and the server does not
  treat it as one.
- `autoResolved` — `true` when a policy has already answered and **nobody
  is asked**: the tool is refused, the run continues, and the server does
  not park. The frame is still sent so the user can see what was refused
  and which policy refused it. A client must not show buttons for it.

## 4. Client → server frames

```jsonc
{ "type": "resume", "lastSeq": 128 }
{ "type": "answer", "requestId": "req_…", "text": "yes, use main" }
{ "type": "decide", "requestId": "req_…", "decision": "allow" | "deny", "remember": false }
{ "type": "ping" }
```

- `decide.remember: true` means "allow this and remember it" — the server
  creates a policy from it. The client does not create the policy.
- `answer` and `decide` may arrive for a request the client has not seen
  (a reconnect). The server answers with the current state, or ignores it
  if the request is already resolved.

## 5. Replay — the resilience rule

When the client reconnects with `lastSeq = N`:

1. The server looks for frames `N+1…` in the **in-memory ring buffer** for
   that session (the last **2000** frames).
2. If the range starts before the buffer, the server reads them from
   **SQLite** (`events` table) and sends them.
3. If the range is older than what SQLite holds, the server sends
   `{ type: "gap", from, to, reason: "too old" }` and the client refetches
   the session over REST.

The server must never silently skip frames. Either the client receives
every sequence number, or it is told about the gap.

**A lost frame can be recalled**: the client may send `resume` at any
time with the last sequence it has, and the server replays.

## 6. The two paths of the stream

This is a hard requirement, not an implementation detail.

```
provider tokens ─┬─► in-memory run buffer ──► on run finish ──► SQLite
                 │                                        (durable)
                 └─► WebSocket ──► frontend (live)
```

- The **in-memory buffer** is the live state of a run. It is the only
  thing the provider writes to while a run is going.
- **On run finish**, the buffer is flushed to SQLite: the messages, the
  events, the run row, and the tool calls.
- The **WebSocket** carries the same frames to the frontend as they
  happen.
- The frontend therefore never waits for the run to finish to see
  anything, and the database is only ever written by the flush.

## 7. SQLite

**Path:** `~/.adh/database/muca.db` — one global database, created on
first use, directory created if missing.

**Implementation:** `node:sqlite` (`DatabaseSync`), which Node 24 ships.
**No new dependency.**

Tables:

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created_at TEXT NOT NULL
);
CREATE TABLE events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT,
  type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, started_at TEXT NOT NULL,
  finished_at TEXT, outcome TEXT, error TEXT, tool_call_count INTEGER DEFAULT 0,
  approval_count INTEGER DEFAULT 0, task_id TEXT
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, request_id TEXT,
  tool_name TEXT NOT NULL, arguments TEXT NOT NULL, status TEXT NOT NULL,
  policy_id TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE requests (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT, status TEXT NOT NULL, answer TEXT,
  created_at TEXT NOT NULL, answered_at TEXT
);
CREATE TABLE policies (
  id TEXT PRIMARY KEY, session_id TEXT, tool_name TEXT NOT NULL,
  match TEXT, effect TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100, label TEXT, created_at TEXT NOT NULL
);
```

- `events` is the durable event log and the replay source. `seq` is
  unique per session.
- `policies.session_id` is `NULL` for a global policy and set for a
  per-session one. A per-session policy wins over a global one.
- The old JSON run history (`apps/server/.muca/runs`) is **removed**.

## 8. The policy engine

A policy is: **tool name** + optional **argument matchers** → **effect**.

- `effect` is `allow`, `ask` or `deny`.
- `match` is a small JSON object of argument matchers, e.g.
  `{ "name": { "startsWith": "fix/" } }`. Supported matchers:
  `equals`, `notEquals`, `startsWith`, `endsWith`, `contains`, `matches`
  (regex), `in`. An array of matchers is an OR; an object is an AND.
- Evaluation order: enabled policies only, highest `priority` first
  (lowest number wins), then per-session before global, then oldest.
  The **first** match decides. There is no fall-through.
- **No matching policy** ⇒ the default by tool class: a tool that
  **writes** (the `writes` axis that already exists) is **asked**; a
  read-only tool is **allowed**.
- The decision is made by the **server**, from the tool being called. The
  model cannot request, escalate or influence a permission decision.
- `decide.remember: true` creates a policy from the decision: same tool,
  same argument matchers, effect `allow`, global, label auto-generated.

## 9. Detached prompting

When the model needs something from the user mid-run, the server parks
the run and emits `clarification_requested`. The user answers whenever
they are next in the UI; the answer is appended to the conversation and
the run continues.

- A parked run does **not** survive a server restart. That is a known
  limitation, accepted.
- Several runs may be parked at once, across sessions.

## 10. Prompt caching and compaction

- The message list is **append-only**. It is never reordered, never
  re-summarised in place, and nothing is moved. That is what keeps the
  provider's cached prefix matching.
- **Anthropic** gets explicit `cache_control: { type: "ephemeral" }` on
  the system prompt and on the last stable message. OpenAI and Gemini
  cache automatically and get nothing extra.
- **Compaction** triggers when the estimated input tokens exceed a
  fraction (default **0.8**) of the model's input limit.
  - The summary prompt is adapted from opencode's MIT-licensed
    `packages/opencode/src/agent/prompt/compaction.txt`, narrowed to
    ops triage. Attribution goes in the file header.
  - Compaction keeps: the last **3** turns verbatim, every tool
    call/result pair, the pending approval and request state, and every
    deployment id, CI run id and issue number already seen.
- **Context limits** are resolved per provider, in this order:
  1. **The provider's own token-counting endpoint**, which is exact:
     - Anthropic: `POST {endpoint}/v1/messages/count_tokens` with the same
       model and messages → `input_tokens`.
     - Gemini: `models/{model}:countTokens` (`countTokens` is in the
       model's `supportedGenerationMethods`) → `totalTokens`.
     - OpenAI: no counting endpoint. Use the model's published limit.
  2. **The provider's models endpoint**, when it publishes the number:
     Gemini's `/v1beta/models` returns `inputTokenLimit`
     (**1,048,576** for `gemini-2.5-flash` and `gemini-2.5-pro`).
     OpenAI's `/v1/models` does **not** publish a context length.
  3. **Anthropic publishes the limit in the response itself** — the
     system prompt of every reply contains
     `<budget:token_budget>200000</budget:token_budget>`. Read it from
     the first real response and remember it.
  4. **A fallback table** in config, per provider and model family:

     | Provider | Family | Input limit |
     |---|---|---|
     | Anthropic | Opus 5.5 / 5 / 4.8 / 4.7 / 4.6, Sonnet 5.5 / 5 / 4.6, Haiku 5.5, Fable 5.1 / 5 | 1,048,576 |
     | Anthropic | Sonnet 4.5, Opus 4.5, Haiku 4.5 (older) | 200,000 |
     | OpenAI | gpt-6 family (astra / sol / luna) | 1,047,576 |
     | OpenAI | gpt-5 family | 400,000 |
     | OpenAI | gpt-4.1 family | 1,047,576 |
     | OpenAI | gpt-4o, gpt-4o-mini | 128,000 |
     | OpenAI | gpt-4 | 8,192 |
     | Google | gemini-2.5-flash / 2.5-pro | 1,048,576 |
     | Google | gemma family | 262,144 |

     A model the table does not name falls back to **128,000**, and the
     fallback is **logged** so it is visible, not silent.
  5. If the limit cannot be established at all, use the table and say so
     in the log. **Never block the boot on it**, and never let a limit
     lookup failure stop a run.
- Compaction triggers on the **counted** input tokens (source 1) when
  they are available, and on the **estimate** otherwise.


## 11. REST additions

Everything below is **additive**. Nothing existing changes shape.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/sessions` | List sessions for the sidebar |
| `POST` | `/api/v1/sessions` | Create a session |
| `GET` | `/api/v1/sessions/:id` | One session: messages, runs, waiting requests |
| `GET` | `/api/v1/sessions/:id/events?fromSeq=` | Replay events from the database |
| `PATCH` | `/api/v1/sessions/:id` | Rename, archive |
| `GET` | `/api/v1/policies` | List policies (global + per session) |
| `POST` | `/api/v1/policies` | Create a policy |
| `PATCH` | `/api/v1/policies/:id` | Edit, enable, disable, reprioritise |
| `DELETE` | `/api/v1/policies/:id` | Delete a policy |
| `GET` | `/api/v1/tools` | **Unchanged** — already exists |

`POST /api/v1/chat` and the MCP endpoint keep their current contracts.
`POST /api/v1/chat` additionally accepts an **optional `sessionId`**: the
client should send the session it is watching, so the run, its events and
its permissions all land in that session. Without it the server falls back
to the single active socket session, and to a fresh session when there is
none.

## 12. Non-negotiables

- **One port.** No new listener, no second port, no proxy.
- **The MCP endpoint is untouched.** It is the hackathon requirement and
  it stays on Streamable HTTP.
- **No authentication.** The socket, the REST API and the MCP endpoint are
  all open, by decision. The server prints a loud warning at boot.
- **Control frames carry `seq: null`.** `hello` and `replayed` do not
  consume a sequence number, so a client that tracked the counter would
  otherwise skip the first real frame as a duplicate.
- **The browser only calls relative paths.** No absolute URLs, no
  hardcoded host or port, in source or in the built bundle.
- **Provider keys are never logged, never in a URL, never in an error
  message.** The OpenRouter-style `Authorization` header is allowed; the
  key never appears in a query string.
- **Zod stays at 4.6.7. The MCP SDK stays at 1.32.1.**
- `node:sqlite` is used for the database. `ws` is the only new
  dependency.
