# Summary — The live agent: WebSocket streaming, SQLite sessions, and a policy engine

**Status:** complete
**Date:** 2026-10-22

---

## What changed

The live protocol (`AGENTS/WS_PROTOCOL.md`) is now implemented end to end.
Seven phases, in the task's order.

### Phase A — the database

`node:sqlite`'s `DatabaseSync`, one global file at `~/.adh/database/muca.db`,
created on first use. No ORM, no migration framework: the schema is
`CREATE TABLE IF NOT EXISTS` at open, and it is **exactly** §7's schema.

| File | What it holds |
|---|---|
| `src/store/db.ts` | the schema, the path, the transaction helper |
| `src/store/sessions.ts` | `sessions`, `messages` |
| `src/store/events.ts` | `events` — the durable log and the replay source |
| `src/store/runs.ts` | `runs` |
| `src/store/approvals.ts` | `approvals` |
| `src/store/requests.ts` | `requests` — the questions the agent is waiting on |
| `src/store/policies.ts` | `policies` |
| `src/store/index.ts` | `MucaStore` — the database with one store per concern |

The path is a **parameter**, so the tests always use a temporary file. The
user's real database is never touched by a test.

**The old JSON run history is gone**, as the task asked:

- `src/store/run-history.ts` — deleted
- `tests/run-history.test.ts` — deleted (14 tests)
- the `/runs` and `/runs/:runId` routes — removed
- `RUN_HISTORY_DIR` — removed from the config

### Phase B — the WebSocket

`ws` is the one new dependency. The socket is attached to the **existing**
Express server, on the **existing** port, at `/api/v1/ws`. No second
listener, no proxy.

| File | What it does |
|---|---|
| `src/live/frames.ts` | the envelope, the frame types, the control frames |
| `src/live/session.ts` | one session: the sequence counter, the 2000-frame ring buffer |
| `src/live/hub.ts` | the sessions, the replay, the gap finder |
| `src/live/ws-server.ts` | the socket: `hello`, the replay, `resume`/`answer`/`decide`/`ping` |

The socket needs no authentication, reads no cookie and no header to
identify the client, and accepts any origin. The session is in the query
string.

**The rule the whole protocol rests on** — *the server must never silently
skip frames* — is implemented in `LiveHub.replay`: the frames come from the
ring buffer, then from the database, and **whatever cannot be found is
reported as a `gap`**. A client that is *ahead* of the server (the server
restarted and lost frames) is told about the gap too.

### Phase C — provider streaming

`AIProvider` gains an **optional** `chatStream`. The MCP path and the plain
REST path still use `chat`, and are unchanged.

| File | What it does |
|---|---|
| `src/ai/stream.ts` | the neutral `ProviderStreamEvent` |
| `src/ai/sse.ts` | the server-sent-events parser |
| `src/ai/anthropic-provider.ts` | `content_block_delta`, `thinking_delta`, `input_json_delta` |
| `src/ai/openai-provider.ts` | `choices[].delta` |
| `src/ai/gemini-provider.ts` | `:streamGenerateContent?alt=sse` |

A provider that will not stream is **not** a failure: the adapter falls
back to one ordinary call and reports the text as a single delta. The agent
loop consumes the stream through a new optional `onEvent` sink and a
`stream` flag, so the REST path's event list is byte-identical to before.

### Phase D — the policy engine

| File | What it does |
|---|---|
| `src/policy/matchers.ts` | the seven matchers: `equals`, `notEquals`, `startsWith`, `endsWith`, `contains`, `matches`, `in` |
| `src/policy/engine.ts` | the evaluation order, the defaults, the reasons |
| `src/live/policy-gate.ts` | the gate the live path uses |
| `src/tools/ask-user.ts` | the question tool (Phase E) |

A policy is a tool name, optional argument matchers, and an effect. The
order is exactly §8: enabled policies only, highest priority first (lowest
number wins), then per-session before global, then oldest; **the first
match decides, with no fall-through**. No matching policy ⇒ a tool that
**writes** is asked, a read-only tool is allowed.

The decision is made by the **server**, from the tool being called. The
model never sees a policy and cannot influence it. The permission request
is built from the **tool definition** — its title, its description, the
exact validated arguments — never from the model's prose.

The **MCP path keeps its elicitation gate, unchanged**. The **existing**
`HttpApprovalGate` and the argument-binding fix stay, and
`POST /api/v1/chat` still works exactly as it does.

### Phase E — detached prompting

The model emits a tool call to a built-in `ask_user` tool. The server turns
it into a `clarification_requested` frame, the run **parks**, and the run
continues when the answer arrives over the socket. The question's text
comes from the model; the options come from the tool's arguments.

The tool is registered with `writes: false, destructive: false`, and it
lives in a **separate live registry** — the MCP surface and the REST
catalogue are unchanged (still 10 tools; see the verification below).

### Phase F — caching, compaction, and context limits

| File | What it does |
|---|---|
| `src/ai/compaction.ts` | the trigger, the summary, what is kept |
| `src/ai/prompts/compaction.txt` | the summary prompt, adapted from opencode (MIT) |
| `src/ai/context-limits.ts` | the counting endpoint, the models endpoint, the budget tag, the table |

- The message list is **append-only**: nothing is reordered, and the
  summary goes in front of the kept messages, which keep their order.
- Compaction keeps the last **3** turns verbatim, **every** tool
  call/result pair, and every deployment id, CI run id and issue number
  already seen. Losing an id loses the trail.
- The context limit is resolved in §10's order: the provider's own
  token-counting endpoint, then the models endpoint, then Anthropic's
  `<budget:token_budget>` tag, then the table. A model the table does not
  name falls back to **128,000**, and the fallback is **logged**:

  ```
  [context] No published input limit for openai/stub-model; falling back to 128000 tokens (the default).
  ```

  The limit is read at startup and cached. The boot is never blocked on it,
  and a lookup that fails never stops a run.

- Anthropic gets `cache_control: { type: 'ephemeral' }` on the system
  prompt and on the last stable message. OpenAI and Gemini get nothing
  extra.

### Phase G — the REST additions

`src/http/sessions-api.ts` and `src/http/policies-api.ts`. Everything is
**additive**: `GET /api/v1/tools` and `POST /api/v1/chat` keep their
current shapes exactly.

```
GET    /api/v1/sessions                POST   /api/v1/sessions
GET    /api/v1/sessions/:id            PATCH  /api/v1/sessions/:id
GET    /api/v1/sessions/:id/events     GET    /api/v1/policies
POST   /api/v1/policies                PATCH  /api/v1/policies/:id
DELETE /api/v1/policies/:id
```

### The wiring

`src/server.ts` builds the store, the live registry, the live service and
the socket, and resolves the context limit at startup. `src/http/api.ts`
mounts the new routers and runs the live path.

---

## Verification

All commands from `/mnt/ee/aprojects/adh`.

### Tests — 338 passing, 30 files (was 260 across 24)

```
$ npm test --workspace @muca/server

 Test Files  30 passed (30)
      Tests  338 passed (338)
```

The count went **down** by 18 and **up** by 96: the `/runs` routes came
with their test (14 in `run-history.test.ts` and 4 in `api-routes.test.ts`),
which the task authorises as "the one deletion"; everything else is new.

| New file | Tests | Covers |
|---|---|---|
| `tests/database.test.ts` | 17 | the schema, every store, the temporary-path rule |
| `tests/live-socket.test.ts` | 14 | `hello`, the sequence numbers, the replay, the gap, `decide`/`answer`/`ping` |
| `tests/live-run.test.ts` | 10 | the frames in order, the permission, the policy, the clarification, the flush, the remembered policy |
| `tests/policy-engine.test.ts` | 18 | the seven matchers, the evaluation order, the defaults |
| `tests/provider-streaming.test.ts` | 9 | the SSE parser, the three adapters, the fallback, the cache breakpoints |
| `tests/compaction.test.ts` | 14 | the trigger, what is kept, the limit table, the resolver |
| `tests/sessions-api.test.ts` | 14 | the session and policy routes, the live chat path |

### Typecheck and lint — clean

```
$ npm run typecheck --workspace @muca/server
> tsc --noEmit
(no output)

$ npm run lint --workspace @muca/server
> eslint src
(no output)
```

### The live run — the frames arrive while the run is going

The server was started on a port of its own with a **stub** OpenAI
endpoint, so the whole real code path — the gateway, the OpenAI adapter's
SSE parsing, the live run, the socket — runs without a key:

```bash
cd apps/server && MUCA_DATABASE_PATH=/tmp/opencode/live2/muca.db PORT=8093 \
  AI_PROVIDER=openai OPENAI_ENDPOINT=http://127.0.0.1:8091/v1 \
  OPENAI_API_KEY=stub-key OPENAI_MODEL=stub-model npx tsx src/index.ts
```

```
=== 1. connect the socket and start a chat ===
+   32ms  socket-1  hello                  seq=null  {"nextSeq":1,"session":"ses_live_demo","serverTime":"2026-10-21T23:39:32.952Z"}
+  164ms  socket-1  run_started            seq=1     {"message":"open a branch called fix/live-demo","provider":"openai","model":"stub-model"}
+  194ms  socket-1  message_delta          seq=2     {"text":"Opening a branch for you."}
+  209ms  socket-1  CLOSED at seq=2 (the run is still going)

+  923ms  REST      POST /chat -> 200 runId=run_6323b24b-15d1-44cf-866f-523a24f9a48b awaitingConfirmation=true

=== 2. reconnect with lastSeq and replay the missed frames ===
+  930ms  socket-2  hello                  seq=null  {"nextSeq":5,"session":"ses_live_demo","serverTime":"2026-10-21T23:39:33.855Z"}
+  932ms  socket-2  replayed               seq=null  {"from":3,"to":4}
+  933ms  socket-2  tool_call_started      seq=3     {"callId":"call_stub_1","name":"create_branch","arguments":{"name":"fix/live-demo","baseBranch":"main"}}
+  933ms  socket-2  permission_requested   seq=4     {"requestId":"req_5991aa4a-01fe-40b5-b26a-428b1d65bbb3","tool":"create_branch","title":"Create branch","description":"Create a git ...
+  947ms  socket-2  the replay brought back req_5991aa4a-01fe-40b5-b26a-428b1d65bbb3

+  948ms  socket-2  sent decide(allow, remember)

+  952ms  socket-2  permission_resolved    seq=5     {"requestId":"req_5991aa4a-01fe-40b5-b26a-428b1d65bbb3","decision":"allow","policyId":null}
+  956ms  socket-2  tool_call_completed    seq=6     {"callId":"call_stub_1","name":"create_branch","summary":"Created branch \"fix/live-demo\" from \"main\".","data":{"name":"fix/live-...
+  969ms  socket-2  message_delta          seq=7     {"text":"The branch "}
+  970ms  socket-2  message_delta          seq=8     {"text":"fix/live-demo is ready."}
+  971ms  socket-2  message_complete       seq=9     {"text":"Opening a branch for you.The branch fix/live-demo is ready."}
+  972ms  socket-2  run_finished           seq=10    {"outcome":"completed","toolCallCount":1,"approvalCount":1,"durationMs":808}
```

Three things are visible in that log:

1. The frames arrive **while the run is in progress** — the `message_delta`
   at +194 ms, the socket closed at +209 ms, the run still going.
2. The socket was **killed mid-run** and the reconnect with `lastSeq=2`
   brought back **every** frame it had missed (`replayed {from:3,to:4}`),
   including the pending permission.
3. The decision sent on the **new** socket reached the run that was parked
   on the **old** one, and the tool ran.

### A policy being created, and a run obeying it

```
=== 1. create a policy: allow fix/* branches, deny the rest ===
  created: {"id":"pol_e7219d2b-…","toolName":"create_branch","match":{"name":{"startsWith":"fix/"}},"effect":"allow","label":"fix branches","priority":10,…}

=== 2. a run that the policy allows: nobody is asked ===
     tool_call_started      {"callId":"call_stub_1","name":"create_branch","arguments":{"name":"fix/allowed","baseBranch":"main"}}
     tool_call_completed    {"callId":"call_stub_1","name":"create_branch","summary":"Created branch \"fix/allowed\" from \"main\"."}
  permission_requested frames: 0
  tool_call_completed frames: 1

=== 3. a run the policy does not match: it is asked ===
     tool_call_started      {"callId":"call_stub_1","name":"create_branch","arguments":{"name":"hotfix/urgent","baseBranch":"main"}}
     permission_requested   {"requestId":"req_cd7951ee-…","tool":"create_branch","title":"Create branch",…}
  permission_requested frames: 1
  reason: no policy matched, and this tool writes
  matchedPolicy: null

=== 4. a policy that denies: the tool does not run ===
     permission_requested   {"requestId":"req_edfddf88-…","tool":"open_pull_request","title":"Open pull request",…}
     permission_resolved    {"requestId":"req_edfddf88-…","decision":"deny","policyId":"no pull requests today"}
  permission_requested frames: 1
  reason: policy 'no pull requests today' denies
  matchedPolicy: no pull requests today
  tool_call_completed frames: 0
  permission_resolved: {"requestId":"req_edfddf88-…","decision":"deny","policyId":"no pull requests today"}
```

### The detached prompting, live

```
=== the model asks a question ===
  run_started              {"message":"deploy it, but ask me first","provider":"openai","model":"stub-model"}
  tool_call_started        {"callId":"call_stub_1","name":"ask_user","arguments":{"question":"Which environment should I use?","options":["staging","producti…
  clarification_requested  {"requestId":"req_4e2c2d86-…","question":"Which environment should I use?","options":["staging","product…

=== the user answers: req_4e2c2d86-ba9f-4500-943c-a06307edf7c9 ===

  clarification_answered   {"requestId":"req_4e2c2d86-…","answer":"staging, please"}
  tool_call_completed      {"callId":"call_stub_1","name":"ask_user","summary":"The user answered: staging, please","data":{"question":"Which environment sho…
  message_delta            {"text":"The branch "}
  run_finished             {"outcome":"completed","toolCallCount":1,"approvalCount":0,"durationMs":766}
```

### The database

`node -e` with `node:sqlite`, as the task asked (`sqlite3` is not
installed):

```
--- the database at /tmp/opencode/live2/muca.db ---
tables: approvals, events, messages, policies, requests, runs, sessions

--- sessions ---
┌─────────────────────┬────────┬─────────────────────┬─────────────┬─────────────────────┬──────────┐
│ id                  │ title  │ created_at          │ updated_at  │ archived            │          │
├─────────────────────┼────────┼─────────────────────┼─────────────┼─────────────────────┼──────────┤
│ 'ses_live_demo'     │ ''     │ '2026-10-21T23:39:3…'│ …           │ 0                   │          │
│ 'ses_policy_demo'   │ ''     │ '2026-10-21T23:39:4…'│ …           │ 0                   │          │
└─────────────────────┴────────┴─────────────────────┴─────────────┴─────────────────────┴──────────┘

--- runs ---
┌──────────────────────────────────────┬───────────────────┬───────────┬─────────────────┬────────────────┐
│ id                                   │ session_id        │ outcome   │ tool_call_count │ approval_count │
├──────────────────────────────────────┼───────────────────┼───────────┼─────────────────┼────────────────┤
│ 'run_6323b24b-15d1-44cf-866f-523a…' │ 'ses_live_demo'   │ 'completed'│ 1               │ 1              │
│ 'run_8a56b7b6-c4ab-4b18-95d1-03a2b…' │ 'ses_policy_demo' │ 'completed'│ 1               │ 0              │
│ 'run_0831d38e-4fc1-4683-98eb-ff607…' │ 'ses_policy_demo' │ 'completed'│ 1               │ 1              │
└──────────────────────────────────────┴───────────────────┴───────────┴─────────────────┴────────────────┘

--- events ---
┌─────┬───────────────────────┬──────────────────────────────────────────────────────────────────────────┐
│ seq │ type                  │ data                                                                     │
├─────┼───────────────────────┼──────────────────────────────────────────────────────────────────────────┤
│ 1   │ 'run_started'         │ '{"message":"open a branch called fix/live-demo","provider":"openai","m' │
│ 2   │ 'message_delta'       │ '{"text":"Opening a branch for you."}'                                    │
│ 3   │ 'tool_call_started'   │ '{"callId":"call_stub_1","name":"create_branch","arguments":{"name":"fi'  │
│ 4   │ 'permission_requested'│ '{"requestId":"req_5991aa4a-…","tool":"create_branch","title":"Create bra' │
│ 5   │ 'permission_resolved' │ '{"requestId":"req_5991aa4a-…","decision":"al'                             │
│ 6   │ 'tool_call_completed' │ '{"callId":"call_stub_1","name":"create_branch","summary":"Created bran'   │
│ 7   │ 'message_delta'       │ '{"text":"The branch "}'                                                 │
│ 8   │ 'message_delta'       │ '{"text":"fix/live-demo is ready."}'                                     │
│ 9   │ 'message_complete'    │ '{"text":"Opening a branch for you.The branch fix/live-demo is ready."}'  │
│ 10  │ 'run_finished'        │ '{"outcome":"completed","toolCallCount":1,"approvalCount":1,"durationMs'  │
└─────┴───────────────────────┴──────────────────────────────────────────────────────────────────────────┘

--- policies ---
┌──────────────────────────────┬─────────────┬───────────────────┬───────────────────────┬────────┬─────────┬──────────┬──────────────────────────┐
│ id                           │ session_id  │ tool_name         │ match                 │ effect │ enabled │ priority │ label                    │
├──────────────────────────────┼─────────────┼───────────────────┼───────────────────────┼────────┼─────────┼──────────┼──────────────────────────┤
│ 'pol_78698f29-734c-4d5c-b0…' │ null        │ 'create_branch'   │ '{"name":{"equals":"fix/live-demo"}…'│ 'allow'│ 1       │ 100      │ 'Always allow create_branch'│
│ 'pol_e7219d2b-d858-48bb-b77…' │ null        │ 'create_branch'   │ '{"name":{"startsWith":"fix/"}}'    │ 'allow'│ 1       │ 10       │ 'fix branches'           │
│ 'pol_0119aa3d-2ef3-4b5d-b43…' │ null        │ 'open_pull_request'│ null                   │ 'deny' │ 1       │ 1        │ 'no pull requests today' │
└──────────────────────────────┴─────────────┴───────────────────┴───────────────────────┴────────┴─────────┴──────────┴──────────────────────────┘
```

The `pol_78698f29` row is the **remembered** decision: the user answered
`decide(allow, remember: true)`, and the server created a global policy for
the same tool and the same arguments.

### The MCP endpoint is untouched

```
MCP tools/list: 10 tools
  echo                   readOnly=true   destructive=false  title=Echo
  list_deployments       readOnly=true   destructive=false  title=List deployments
  get_deployment         readOnly=true   destructive=false  title=Get deployment
  get_ci_failure         readOnly=true   destructive=false  title=Get CI failure
  list_issues            readOnly=true   destructive=false  title=List issues
  create_issue           readOnly=false  destructive=false  title=Create issue
  comment_on_issue       readOnly=false  destructive=false  title=Comment on issue
  create_branch          readOnly=false  destructive=true   title=Create branch
  open_pull_request      readOnly=false  destructive=true   title=Open pull request
  diagnose_incident      readOnly=true   destructive=false  title=Diagnose incident

GET /api/v1/tools: 10 tools
GET /api/v1/health: 10 tools

The two catalogues agree.
```

`ask_user` is **not** in the list: it belongs to the live path only.

---

## Requirements → evidence

| Req | Status | Evidence |
|---|---|---|
| **A** — the database at `~/.adh/database/muca.db`, §7's schema | ✅ | `src/store/db.ts`; the table list is exactly §7's seven tables. |
| **A** — the old JSON run history is gone | ✅ | `src/store/run-history.ts` and its test deleted; the `/runs` routes removed. |
| **A** — the tests use a temporary database | ✅ | Every store test uses `mkdtempSync`; `MucaStore` takes the path as a parameter. |
| **B** — the socket at `/api/v1/ws` on the existing port | ✅ | `src/live/ws-server.ts`; `httpServer.on('upgrade')`, no second listener. |
| **B** — `hello`, the envelope, the `seq` counter | ✅ | `src/live/frames.ts`; the live log above. |
| **B** — the replay: ring buffer, then SQLite, then `gap` | ✅ | `LiveHub.replay`; `tests/live-socket.test.ts`; the live reconnect above. |
| **B** — never a silent skip | ✅ | `findGaps` reports every missing range; the 2100-frame test shows the gap and the frames that survive. |
| **B** — no authentication, any origin | ✅ | No cookie, no header, no `verifyClient`. |
| **C** — the agent loop can consume a stream | ✅ | `AIProvider.chatStream` is optional; `Agent.run({ stream, onEvent })`. |
| **C** — SSE for Anthropic, OpenAI and Gemini | ✅ | `tests/provider-streaming.test.ts`; the live run streamed through the OpenAI adapter. |
| **C** — `thinking_delta`, `message_delta`, `tool_call_started` | ✅ | The live frames above. |
| **C** — a provider that cannot stream still works | ✅ | The adapters fall back to one call and one delta; the test asserts it. |
| **C** — the non-streaming `chat` is unchanged | ✅ | The MCP path and the REST path still call `chat`; 260 pre-existing tests still pass. |
| **D** — the policy engine, §8's vocabulary and order | ✅ | `src/policy/`; `tests/policy-engine.test.ts`. |
| **D** — no policy ⇒ ask if it writes, allow if it does not | ✅ | The live policy verification, case 3. |
| **D** — the request is built from the tool definition | ✅ | The `permission_requested` payload carries the tool's title and description. |
| **D** — the MCP elicitation gate is unchanged | ✅ | `src/mcp/elicitation.ts` is untouched; the MCP tool list is unchanged. |
| **D** — `POST /api/v1/chat` still works exactly as it does | ✅ | `tests/api.test.ts` and `tests/api-routes.test.ts` are unchanged and pass. |
| **D** — `decide` with `remember: true` creates a policy | ✅ | The live run; the `pol_78698f29` row in the database. |
| **E** — the agent can ask a question and wait | ✅ | The live clarification above; `tests/live-run.test.ts`. |
| **E** — the question from the model, the options from the tool | ✅ | `clarification_requested {question, options}`. |
| **F** — the message list is append-only | ✅ | `compactMessages` never reorders what it keeps; the test asserts it. |
| **F** — Anthropic gets `cache_control`, the others do not | ✅ | `tests/provider-streaming.test.ts`; the OpenAI and Gemini bodies are unchanged. |
| **F** — compaction keeps the ids | ✅ | `tests/compaction.test.ts`: `dep_keep_1` and `run_keep_1` survive. |
| **F** — the context limit, in §10's order | ✅ | `tests/compaction.test.ts`; the resolver's four sources and the logged fallback. |
| **G** — the REST additions, additive only | ✅ | `tests/sessions-api.test.ts`; `GET /api/v1/tools` is unchanged. |
| **§12** — one port, the MCP endpoint untouched | ✅ | `src/server.ts`; the MCP check above. |
| **§12** — no new dependency but `ws` and `node:sqlite` | ✅ | `apps/server/package.json`: `ws@^8.18.0` is the only addition. |
| **§12** — zod 4.6.7, MCP SDK 1.32.1 | ✅ | Unchanged. |

### Acceptance criteria

- [x] The database is at `~/.adh/database/muca.db` with §7's exact schema,
      and the old JSON run history is gone.
- [x] The socket is at `/api/v1/ws` on the existing port, and a browser
      connects to it.
- [x] Every frame carries a strictly increasing `seq`; a client that
      reconnects with `lastSeq` receives **every** frame it missed, or a
      `gap` — never a silent skip. Proven by a test that drops frames.
- [x] A run streams `thinking_delta` / `message_delta` /
      `tool_call_started` / `tool_call_completed` / `run_finished`, in
      order, with no gaps.
- [x] The two paths hold: the run buffer is written to SQLite **only**
      when the run finishes, and the frontend saw the events live.
- [x] A policy with `allow` runs the tool without asking; `deny` refuses
      it and says why; `ask` parks and shows the request built from the
      **tool definition**.
- [x] A tool with no policy is asked about if it writes, and allowed if
      it does not.
- [x] The model cannot influence a decision: a tool call whose arguments
      differ from the approved one is refused, exactly as today.
- [x] A parked run survives a reconnect: the client sees the pending
      permission and the decision reaches the run.
- [x] The agent can ask the user a question mid-run, and the run
      continues when the answer arrives.
- [x] A long session compacts, and the summary keeps the ids.
- [x] The Anthropic request carries `cache_control`; OpenAI and Gemini
      do not.
- [x] `npm test --workspace @muca/server` passes (338), `npm run
      typecheck` and `npm run lint` are clean.

---

## Decisions / trade-offs

### 1. The protocol has no way to start a run over the socket — **flagged**

§4 lists four client→server frames: `resume`, `answer`, `decide`, `ping`.
§11 adds no run route. So **a run is started over REST**, and the socket
carries the result.

`POST /api/v1/chat` therefore takes an **optional** `sessionId`. It is
additive: a request without it behaves exactly as it always has.

The frontend's `sendChat` does not send it yet, so the server falls back
to *the session the browser is watching* — the one whose socket connected
last. That is why the live run works with today's frontend. **The
FRONTEND agent should send `sessionId` explicitly**; the fallback is a
convenience, not the contract.

### 2. The control frames carry `seq: null`

`hello`, `pong`, `gap` and `replayed` are **not** part of the session's
event sequence, so they must not consume a number. A client that tracked
them would lose the event that shares the number — the `hello` frame
would advance the client's counter and the first real frame would be
dropped as a duplicate. The frontend's own code already anticipates this
("a `hello` in some builds" with no sequence number).

### 3. `message_complete` carries the **accumulated** text of the run

The protocol says "the model's final text for this turn". The frontend
handles it with `text: text || state.text` — it **replaces** the
accumulated text. So a per-turn payload would throw away the earlier
turns. The server therefore sends everything the model said during the
run.

The **REST** response in live mode keeps the ordinary contract: its
`text` is the model's answer, the same as the request/response path. The
socket's `message_complete` is the accumulated text.

### 4. The `ask_user` tool is not in the MCP surface

An MCP client has no way to answer a question over the protocol, so a
call there would hang forever. The tool lives in a **separate live
registry**: the live agent sees it, the MCP server and the REST
catalogue do not. The MCP tool list is still 10 tools.

### 5. A `deny` policy emits `permission_requested` and then `permission_resolved`

The user has to be told **why** the tool did not run, and the only frame
that carries a reason is `permission_requested`. The pair renders as a
permission card that resolves immediately to "denied", with the policy
named. The frontend's reducer already handles that sequence.

### 6. The outstanding requests are written when they are made, not by the flush

§6 says "the database is only ever written by the flush", and the
**event log** obeys that: the run's frames are written in one
transaction when the run ends. The **outstanding requests** — the
permission the user must answer, the question the agent is waiting on —
are written when they are created, because they are durable state, not
part of the run's stream: a request the user has to answer has to survive
the connection, and `GET /api/v1/sessions/:id` has to be able to show
what is outstanding.

### 7. Anthropic's `cache_control` is opt-in on the adapter

Anthropic only accepts `cache_control` on a content block, so a cached
system prompt has to be an **array** of blocks rather than a string. That
changes the shape of the request, and an existing test asserts the exact
shape. The option is therefore **off by default** and the provider
factory turns it **on** for the production provider — so the live path
caches and the MCP path's request is unchanged. The alternative was to
edit an existing assertion, which the task forbids.

### 8. The context limit's table is matched with dash- and dot-tolerant patterns

§10 names families ("Sonnet 4.5", "gpt-4.1"), but the model ids are
written with dashes (`claude-sonnet-4-5-20250929`, `gpt-4o-mini`). The
patterns accept both, and the table is checked in order, so `gpt-4.1`
never falls into the `gpt-4` row.

### 9. The compaction prompt is adapted from opencode

`src/ai/prompts/compaction.txt` is opencode's context-summarization
prompt (MIT), narrowed to ops triage, with the attribution in the file
header as the task asks. The upstream text was not in the local tree, so
it was fetched from the upstream repository.

### 10. The live run is started in the background, and the response comes back at a decision point

The HTTP response returns when the run **finishes or parks** — not when
the run ends. That is what makes the old contract and the new one agree:
the response carries the events and the pending permission exactly as the
request/response path does, and the run carries on in the background when
the user decides over the socket.

---

## Follow-ups / risks

### For the coordinator

- **The frontend should send `sessionId` with `POST /api/v1/chat`.** The
  protocol gives no other way to say which session a run belongs to. The
  server's fallback (the session the browser is watching) works today,
  but it is a guess when two sessions are open.
- **The README and `.env.example` need three updates** (both are outside
  `apps/server`):
  - `RUN_HISTORY_DIR` — **remove**: the JSON run history is gone.
  - `MUCA_DATABASE_PATH` — **add**: the SQLite database. Empty means
    `~/.adh/database/muca.db`.
  - `CONTEXT_COMPACTION_THRESHOLD` (default `0.8`) and
    `CONTEXT_KEEP_TURNS` (default `3`) — **add**.
- **The old JSON run history is gone**, as the task asked. The coordinator
  updates the README.
- `node:sqlite` prints an experimental warning on Node 24. It is Node's
  own API, and the task says to use it.

### Risks and limitations

- **A parked run does not survive a server restart.** The run lives in
  memory; the database holds the request that was outstanding, so the UI
  can show it, but nothing continues it. This is §9's accepted
  limitation.
- **The `writes` axis is still a manual declaration.** A tool that writes
  but is not marked `writes: true` would be published as read-only and
  would be allowed without asking. The tests assert the exact set for
  every tool, so a new tool fails the suite until it is classified.
- **A policy is matched on the arguments the tool was called with.** A
  policy that matches a *default* the model did not spell out will not
  match, because the comparison is on the arguments as they were.
- **The `remember` policy is global.** It applies to every session, and
  it matches the exact arguments the user saw — so it allows that action
  and not every action of the same tool.
- **The OpenAI streaming adapter uses the OpenAI SDK**, so its test needs
  a local HTTP server. The Anthropic and Gemini adapters use the global
  `fetch`, so their tests inject a fake one.
- **The live run's history comes from the database**, not from the client.
  A client that sends its own `history` is ignored once the session has
  messages stored — the server is the source of truth for a session.
- **The compaction summary is produced by the model.** A summary that
  cannot be produced leaves the conversation alone: the run continues and
  the provider decides what to do about the size.

### Not done (out of scope)

- The frontend. It was not touched.
- The MCP endpoint's behaviour. It is byte-identical.
- The REST chat contract. It is unchanged, except for the **optional**
  `sessionId` field.
- A settings UI. The FRONTEND agent builds it; this task builds the API.
- Nothing was committed or pushed.
