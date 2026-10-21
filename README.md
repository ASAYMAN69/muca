# Muca — Amazon Developer Hackathon 2026 (Alexa+ track)

Muca is an AI agent that does real work through **MCP tools**. It is not a
chatbot that only generates text: the model discovers tools over the Model
Context Protocol, calls them, reads the real results, and answers using them.

This repository is the working skeleton. The MCP server, the tool layer, the
agent loop, the REST API and the web client all exist and are covered by
tests. The **use case is not finalised yet** — the tools in
`apps/server/src/tools/index.ts` are placeholders that prove the full
pipeline, and they get replaced once the use case is decided.

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
                      │    │                        └── tool registry (Zod schemas)    │
                      │    ├── /api/v1/health ──►  REST API                            │
                      │    ├── /api/v1/tools  ──►  REST API                            │
                      │    ├── /api/v1/chat   ──►  REST API ──► Agent loop ──► Provider│
                      │    └── /*           ──►  Next.js frontend (React + Tailwind)    │
                      └────────────────────────────────────────────────────────────────┘
```

The three concerns are kept apart on purpose:

| Layer | Location | Responsibility |
|---|---|---|
| Transport | `apps/server/src/mcp/http-handler.ts` | MCP session lifecycle, protocol negotiation, routing |
| Tool execution | `apps/server/src/tools/` | Schemas, validation, business behaviour |
| AI orchestration | `apps/server/src/ai/` | The tool-calling loop, provider abstraction |

The agent loop talks to the **tool registry**, not to the MCP transport. The
MCP server and the REST API are two front doors onto the same registry.

---

## Quick start

```bash
# 1. install
npm install

# 2. configure
cp .env.example .env
#    then put your OpenAI key in .env

# 3. run
npm run dev
```

Open <http://localhost:8099>.

The server prints its configuration on boot:

```
  Muca — Amazon Developer Hackathon 2026 (Alexa+ track)
  ---------------------------------------------------
  Frontend   http://localhost:8099/
  REST API   http://localhost:8099/api/v1
  MCP        http://localhost:8099/api/v1/mcp
  Protocol   2025-11-25
  AI         gpt-4o-mini (https://api.openai.com/v1)
```

The MCP endpoint is a standard Streamable HTTP endpoint — any MCP client
can connect to it. To check it by hand:

```bash
curl -s http://localhost:8099/api/v1/health | head -c 400
```

---

## Configuration

All configuration lives in `.env` (see `.env.example`). Nothing is hardcoded.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8099` | The single port for the frontend, the API and MCP |
| `ALLOWED_ORIGINS` | `http://localhost:8099` | CORS allow-list for the API |
| `OPENAI_API_KEY` | *(empty)* | Enables the agent. Empty ⇒ the UI shows "AI not configured" |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `OPENAI_MODEL` | `gpt-4o-mini` | Model id |
| `MCP_PROTOCOL_VERSION` | `2025-11-25` | Protocol version advertised by the server |
| `MCP_PUBLIC_URL` | `http://localhost:${PORT}/api/v1/mcp` | Public URL of the MCP endpoint |

**Never commit `.env`.** It is git-ignored; `.env.example` is the template.

---

## The MCP layer

- **SDK:** `@modelcontextprotocol/sdk@1.32.1` (pinned exactly).
- **Protocol:** `2025-11-25`, which is `LATEST_PROTOCOL_VERSION` in that SDK
  release. Version negotiation is handled by the SDK, and the server
  advertises `tools` capability.
- **Transport:** Streamable HTTP, **stateful**. A client POSTs an
  `initialize` request, receives an `Mcp-Session-Id` header, and must send
  that header on every later request. `GET` opens the server→client SSE
  stream, `DELETE` tears the session down.

### Verifying the protocol by hand

`apps/server/src/mcp/client.ts` contains a real MCP client used for
self-checks. A quick end-to-end probe:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'probe', version: '0.1.0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8099/api/v1/mcp')));

console.log(client.getServerVersion());
console.log((await client.listTools()).tools.map((t) => t.name));
await client.close();
```

---

## The agent loop

`apps/server/src/ai/agent.ts`. Each turn:

1. Send the conversation plus the tool catalogue to the model.
2. If the model requested tools, validate the arguments against the tool's
   Zod schema, then run the tool.
3. Feed the tool results back as `tool` messages and repeat.
4. Stop when the model answers without requesting a tool.

**Confirmation gate.** Tools marked `destructive: true` (e.g. `delete_note`,
`clear_notes`) are never executed without an explicit user approval. When the
model asks for one, the loop stops and returns `awaitingConfirmation` with the
pending call. The web client renders an Approve / Cancel prompt and replays
the request with the call id in `approvedCallIds`.

**Provider abstraction.** The loop depends on the `AIProvider` interface
(`apps/server/src/ai/provider.ts`), not on the OpenAI SDK. Swapping providers
means implementing one interface; nothing else changes. The OpenAI adapter
lives in `apps/server/src/ai/openai-provider.ts`.

---

## Tools

Placeholder tools, chosen to exercise every part of the pipeline. Replace
them once the use case is decided — the plumbing does not change.

| Tool | Destructive | Purpose |
|---|---|---|
| `echo` | no | Proves a tool call round trip |
| `create_note` | no | Writes state, returns an id |
| `list_notes` | no | Reads state, supports filtering |
| `get_note` | no | Reads one record, errors on a missing id |
| `delete_note` | **yes** | Triggers the confirmation gate |
| `clear_notes` | **yes** | Triggers the confirmation gate |
| `get_weather` | no | Deterministic mock of an external API |

Tools are declared in `apps/server/src/tools/index.ts` with a Zod schema.
The MCP SDK converts the schema to JSON Schema and publishes it in
`tools/list`, so any MCP client can discover them.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/health` | Status, protocol version, AI state, tool list |
| `GET` | `/api/v1/tools` | Tool catalogue with input schemas |
| `POST` | `/api/v1/chat` | Run the agent. Body: `{ message, history[], approvedCallIds[] }` |
| `*` | `/api/v1/mcp` | MCP Streamable HTTP endpoint |

---

## Testing

```bash
npm test          # backend test suite
npm run typecheck # both workspaces
npm run lint      # both workspaces
```

The suite covers the four things the hackathon asks for:

| Area | File | What it proves |
|---|---|---|
| MCP initialisation | `apps/server/tests/mcp-protocol.test.ts` | `initialize` handshake, capability negotiation, session id |
| Tool discovery | `apps/server/tests/mcp-protocol.test.ts` | `tools/list` returns schemas, annotations, destructive hints |
| Tool execution | `apps/server/tests/mcp-protocol.test.ts` | `tools/call` runs, validates, rejects bad input, keeps state |
| AI tool calling | `apps/server/tests/agent.test.ts` | The loop calls tools, feeds results back, gates destructive calls, survives provider errors |
| REST API | `apps/server/tests/api.test.ts` | Health, tools, chat, validation errors, unconfigured-AI path |

The MCP tests use the **real** SDK client against a **real** HTTP server —
nothing is stubbed.

---

## Layout

```
adh/
├── apps/
│   ├── server/                 # Express + MCP + agent loop
│   │   ├── src/
│   │   │   ├── ai/             # provider abstraction + agent loop
│   │   │   ├── http/           # REST API routes
│   │   │   ├── mcp/            # MCP server + Streamable HTTP transport
│   │   │   ├── tools/          # tool registry + tool implementations
│   │   │   ├── config.ts       # env parsing
│   │   │   ├── server.ts       # the single Express app
│   │   │   └── index.ts        # entrypoint
│   │   └── tests/
│   └── web/                    # Next.js + React + Tailwind
│       ├── app/                # app router
│       └── lib/api.ts          # the only API client
├── .env.example
└── package.json                # npm workspaces root
```

---

## Known limitations

These are deliberate and known — nothing here is a hidden failure.

1. **No real use case yet.** The tools are placeholders. The final use case
   replaces `apps/server/src/tools/index.ts`.
2. **Not integrated with Alexa+.** Muca runs as a web client. No Alexa
   integration is claimed.
3. **In-memory tool state.** Notes live in a `Map` and are lost on restart.
   Fine for a demo; not durable.
4. **Single-process, no auth.** The API is open. Do not expose it publicly
   without adding authentication.
5. **No streaming.** The agent returns the full response at once. The
   `events` array is already ordered, so streaming can be added later
   without changing the agent loop.
6. **The AI provider is required for the UI to be useful.** Without
   `OPENAI_API_KEY` the MCP server and API still work, but the chat UI is
   disabled.

## What is deliberately absent

- No AWS infrastructure. The hackathon does not require it for Option A, and
  adding it would be scope creep.
- No database, no queue, no cache, no Docker, no CI. The brief asks for a
  straightforward implementation without unnecessary dependencies.
- No abstraction layers beyond the three that the brief explicitly asks to
  keep separate.
