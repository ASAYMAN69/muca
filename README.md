# Muca — Ops Copilot for deployment and CI failures

**Amazon Developer Hackathon 2026 — Alexa+ track, Option A (self-hosted MCP server).**

Muca is an AI agent that does real work through **MCP tools**. It is not a
chatbot that only generates text: the model discovers tools over the Model
Context Protocol, calls them, reads the real results, and answers using them.

The use case is **deployment and CI failure triage**. A failed rollout is
correlated with its CI run and the matching issue, the evidence is presented,
and — **only with an explicit approval** — a branch and a pull request are
opened with the fix.

> **Honesty note:** Muca is **not** integrated with Alexa+. It ships as a
> custom web client. The MCP server is self-hosted over Streamable HTTP,
> which is the "Option A" path the hackathon requires.

---

## Architecture

One process, one port. The Express server hosts the Next.js frontend and
the API side by side.

```
                      ┌─────────────────────────── PORT 8099 ───────────────────────────┐
   Browser  ────────► │  Express                                                      │
                      │    ├── /api/v1/mcp   ──►  MCP Server (Streamable HTTP)         │
                      │    │                        └── tool catalogue (one source)     │
                      │    ├── /api/v1/health ──►  REST API                            │
                      │    ├── /api/v1/tools  ──►  REST API                            │
                      │    ├── /api/v1/chat   ──►  REST API ──► Agent loop ──► Gateway│
                      │    └── /*           ──►  Next.js frontend (React + Tailwind)    │
                      └────────────────────────────────────────────────────────────────┘
```

The three concerns are kept apart on purpose:

| Layer | Location | Responsibility |
|---|---|---|
| Transport | `apps/server/src/mcp/http-handler.ts` | MCP session lifecycle, protocol negotiation, routing |
| Tool execution | `apps/server/src/tools/` | Schemas, validation, business behaviour |
| AI orchestration | `apps/server/src/ai/` | The tool-calling loop, the provider gateway, the approval gate |

The agent loop talks to the **tool catalogue**, not to the MCP transport.
The MCP server and the REST API are two front doors onto the same tools.

---

## Quick start

```bash
# 1. install
npm install

# 2. configure (optional — see "AI gateway" below)
cp .env.example .env
#    then put a key in ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY

# 3. run
npm run dev
```

Open <http://localhost:8099>. That single command serves the frontend, the
REST API and the MCP endpoint on **one port**.

The server prints its configuration on boot:

```
  Muca — Amazon Developer Hackathon 2026 (Alexa+ track)
  ---------------------------------------------------
  Frontend   http://localhost:8099/
  REST API   http://localhost:8099/api/v1
  MCP        http://localhost:8099/api/v1/mcp
  Protocol   2025-11-25
  AI gateway  auto → none — the server will run without a model  probes: anthropic not_configured · openai timeout 4004ms · gemini not_configured
             No usable AI provider — MCP, the tools and the demo mode still work.
```

**No API key is fine.** Muca boots, the MCP server works, the tool catalogue
is published, and the web UI offers a clearly-labelled scripted demo.

---

## The MCP layer

- **SDK:** `@modelcontextprotocol/sdk@1.32.1` (pinned exactly).
- **Protocol:** `2025-11-25`, which is `LATEST_PROTOCOL_VERSION` in that SDK
  release. The server advertises `tools` **and** `tasks` capabilities.
- **Transport:** Streamable HTTP, **stateful**. A client POSTs an
  `initialize` request, receives an `Mcp-Session-Id` header, and must send
  that header on every later request. `GET` opens the server→client SSE
  stream, `DELETE` tears the session down.

Three protocol-native features are used, not re-implemented:

| Feature | Where it shows up |
|---|---|
| **Tools** | 10 tools with JSON-Schema arguments and `destructiveHint` / `readOnlyHint` annotations |
| **Tasks** | `diagnose_incident` returns a task handle; the client polls `tasks/get` until it reaches a terminal state |
| **Elicitation** | an MCP client is *asked* for approval inside the tool call, with the exact arguments, and the tool runs only if the client accepts |

### Verifying the protocol by hand

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'probe', version: '0.1.0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8099/api/v1/mcp')));

console.log(client.getServerVersion());          // { name: 'muca-mcp', version: '0.2.0' }
console.log(client.getServerCapabilities());     // { tools: …, tasks: … }
console.log((await client.listTools()).tools.map((t) => t.name));
await client.close();
```

The **web client does the same thing in the browser**: the MCP session panel
on the right of the UI is a real SDK client against the same-origin
`/api/v1/mcp`, showing the negotiated protocol version, the live session id,
the discovered tools and the raw JSON-RPC traffic. Nothing about the
protocol is mocked.

---

## The tools

Declared once in `apps/server/src/tools/catalogue.ts`; the MCP layer and the
REST layer both derive from it, so they cannot drift apart.

| Tool | Writes? | Destructive | Purpose |
|---|---|---|---|
| `echo` | no | no | Proves a tool-call round trip |
| `list_deployments` | no | no | Recent deployments per service, with status, commit and log tail |
| `get_deployment` | no | no | One deployment, with its CI run and log tail |
| `get_ci_failure` | no | no | The failing job, step, error and log excerpt |
| `list_issues` | no | no | Issues by state, with labels |
| `create_issue` | **yes** | no | Opens an issue from the diagnosis |
| `comment_on_issue` | **yes** | no | Adds the evidence to an existing issue |
| `create_branch` | **yes** | **yes** | Creates the fix branch — requires approval |
| `open_pull_request` | **yes** | **yes** | Opens the PR with the fix — requires approval |
| `diagnose_incident` | no | no | **Task-backed**: correlates deployment + CI + issue and returns a diagnosis |

The domain is deployment / CI triage. The adapters are **seeded mocks**
(`apps/server/src/tools/ops/mock.ts`) — deterministic, correlated, and
credential-free, so the whole flow is demonstrable without any external
account. The adapter seam (`OpsAdapters`) is where a real GitHub or
CI provider would be plugged in.

---

## The approval gate

Safety is the product's headline claim, so it is enforced in one place
(`apps/server/src/ai/approval-gate.ts`) with two front doors:

- **MCP clients** are asked with **Elicitation**, inside the tool call, with
  that call's exact arguments. A client that does not declare the
  capability gets a refusal.
- **The web client** approves over plain HTTP: the server parks the run and
  hands the client a `pendingCall`.

An approval is an **action, not a tool**. It records the tool *and* the
exact arguments the user saw, compared canonically and consumed once. A
later call to the same tool with different arguments is a different action
and parks again for a fresh confirmation. A call id the server never issued
authorises nothing.

```
POST /api/v1/chat  { "message": "open a fix PR" }
→ { "awaitingConfirmation": true,
    "pendingCall": { "callId": "call_x", "name": "create_branch",
                     "arguments": { "name": "fix/checkout-rounding" } } }

POST /api/v1/chat  { "message": "yes", "approvedCallIds": ["call_x"] }
→ the tool runs — with exactly those arguments
```

---

## The AI gateway

Muca works with whichever key you have. Up to three HTTP endpoints are
configured from the environment, **probed in parallel at startup** with a
real minimal request, and the highest-priority one that answers is used:

```
anthropic  >  openai  >  gemini
```

A probe is classified, not reduced to a boolean:

| Status | Meaning | Usable? |
|---|---|---|
| `ok` | 2xx with a parseable body | yes |
| `throttled` | 429 — the key is valid, it is rate-limited | **yes** |
| `invalid_key` | 401 / 403 | no |
| `bad_request` | other 4xx (bad model id, wrong path) | no |
| `unreachable` | network error | no |
| `timeout` | the probe deadline elapsed | no |
| `not_configured` | no key | no |

If nothing is usable the server **still boots** — MCP, the tools and the
demo mode do not need a model. Set `AI_PROVIDER=anthropic` (or `openai`,
`gemini`, `bedrock`) to pin one explicitly; an explicit choice never
silently switches to a different provider.

`GET /api/v1/health` reports the decision and every probe;
`POST /api/v1/ai/probe` re-runs the probes on demand.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Status, protocol version, AI gateway state, tool list |
| `GET` | `/api/v1/tools` | Tool catalogue with input schemas |
| `POST` | `/api/v1/chat` | Run the agent. Body: `{ message, history[], approvedCallIds[] }` |
| `GET` | `/api/v1/runs` | Run history (persisted across restarts) |
| `GET` | `/api/v1/runs/:id` | One run, with every tool call and its result |
| `GET` | `/api/v1/tasks` / `/api/v1/tasks/:id` | Long-running task status |
| `POST` | `/api/v1/ai/probe` | Re-run the provider probes (diagnostic only) |
| `*` | `/api/v1/mcp` | MCP Streamable HTTP endpoint |

---

## Configuration

All configuration lives in `.env` (see `.env.example`). Nothing is
hardcoded, and **never commit `.env`** — it is git-ignored.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8099` | The single port for the frontend, the API and MCP |
| `ALLOWED_ORIGINS` | `http://localhost:8099` | CORS allow-list for the API |
| `AI_PROVIDER` | `auto` | `auto` \| `anthropic` \| `openai` \| `gemini` \| `bedrock` |
| `AI_PROBE_TIMEOUT_MS` | `4000` | Deadline for a single provider probe |
| `ANTHROPIC_API_KEY` | *(empty)* | Anthropic (Messages API) |
| `ANTHROPIC_ENDPOINT` | `https://api.anthropic.com` | Anthropic base URL |
| `ANTHROPIC_MODEL` | *(empty)* | Anthropic model id — **required** to use Anthropic |
| `OPENAI_API_KEY` | *(empty)* | OpenAI, or any OpenAI-compatible endpoint |
| `OPENAI_ENDPOINT` | `https://api.openai.com/v1` | OpenAI base URL |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model id |
| `GEMINI_API_KEY` | *(empty)* | Google Gemini (`generateContent`) |
| `BEDROCK_MODEL_ID` | *(empty)* | AWS Bedrock, when `AI_PROVIDER=bedrock` |
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `MCP_PROTOCOL_VERSION` | `2025-11-25` | Protocol version advertised by the server |
| `MCP_PUBLIC_URL` | `http://localhost:${PORT}/api/v1/mcp` | Public URL of the MCP endpoint |
| `RUN_HISTORY_DIR` | `apps/server/.muca/runs` | Where run history is written |

---

## Testing

```bash
npm test          # 229 backend tests across 17 files
npm run typecheck # both workspaces
npm run lint      # both workspaces
npm run build     # production build of both apps
```

| Area | File | What it proves |
|---|---|---|
| MCP initialisation | `tests/mcp-protocol.test.ts` | `initialize` handshake, capability negotiation, session id |
| Tool discovery | `tests/mcp-protocol.test.ts` | `tools/list` returns schemas, annotations, destructive hints |
| Tool execution | `tests/mcp-protocol.test.ts` | `tools/call` runs, validates, rejects bad input |
| Elicitation | `tests/elicitation.test.ts` | A real client is asked, and a client without the capability is refused |
| MCP Tasks | `tests/tasks.test.ts` | A task handle is returned, polled and reaches a terminal state |
| AI tool calling | `tests/agent.test.ts` | The loop calls tools, feeds results back, gates destructive calls, survives provider errors |
| Approval safety | `tests/approval-*.test.ts` | An approval authorises one action, not one tool; a fabricated id authorises nothing |
| AI gateway | `tests/provider-gateway.test.ts` | Parallel probes, priority selection, 429 usable / 401 not, timeouts |
| Provider adapters | `tests/provider-adapters.test.ts` | Anthropic and Gemini map the full conversation, including tool calls |
| REST API | `tests/api.test.ts`, `tests/api-routes.test.ts` | Health, tools, chat, validation errors, run history |
| Catalogue | `tests/tool-catalogue.test.ts` | One catalogue feeds MCP and REST; `diagnose_incident` is task-backed |

The MCP tests use the **real** SDK client against a **real** HTTP server —
nothing is stubbed. The provider tests inject a fake `fetch`, so the suite
never touches a network.

---

## Layout

```
adh/
├── AGENTS/                     # one folder per agent: tasks + summaries
├── apps/
│   ├── server/                 # Express + MCP + agent loop + gateway
│   │   ├── src/
│   │   │   ├── ai/             # agent loop, provider gateway, approval gate
│   │   │   ├── http/           # REST API routes
│   │   │   ├── mcp/            # MCP server, transport, tasks, elicitation
│   │   │   ├── store/          # run history, pending approvals
│   │   │   ├── tools/          # catalogue + Ops Copilot tool implementations
│   │   │   ├── config.ts       # env parsing
│   │   │   ├── server.ts       # the single Express app
│   │   │   └── index.ts        # entrypoint
│   │   └── tests/
│   └── web/                    # Next.js + React + Tailwind
│       ├── app/                # app router + components
│       └── lib/                # API client, MCP client, timeline, demo
├── .env.example
└── package.json                # npm workspaces root
```

---

## Known limitations

These are deliberate and known — nothing here is a hidden failure.

1. **Not integrated with Alexa+.** Muca runs as a web client. No Alexa
   integration is claimed.
2. **The ops adapters are seeded mocks.** The triage flow is real, but it
   reads from a deterministic in-memory world rather than GitHub or a CI
   provider. The `OpsAdapters` seam is where the real ones go.
3. **Single-process, no auth.** The API is open. Do not expose it publicly
   without adding authentication.
4. **No streaming.** The agent returns the full response at once. The
   `events` array is already ordered, so streaming can be added later
   without changing the agent loop.
5. **Run history is a JSON file per run**, not a database. Fine for a demo
   and for the "state across sessions" requirement; not a real store.
6. **The tool adapters write to a mock world**, so a branch or pull request
   created during a demo does not exist anywhere else.

## What is deliberately absent

- No AWS infrastructure. The hackathon does not require it for Option A, and
  adding it would be scope creep. (Amazon Bedrock is supported as an AI
  provider, using the standard AWS credential chain — that is a client
  library, not infrastructure.)
- No database, no queue, no cache, no Docker, no CI. The brief asks for a
  straightforward implementation without unnecessary dependencies.
- No abstraction layers beyond the three the brief explicitly asks to keep
  separate.
