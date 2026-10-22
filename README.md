# Muca

**An AI agent that investigates why a deployment broke — and fixes it, but only after you say so.**

Built for the [Amazon Developer Hackathon 2026](https://developer.amazon.com/en-US/hackathon) (Alexa+ track, Option A: a self-hosted MCP server).

Muca is not a chatbot that generates text. It is an agent that **uses tools**: it discovers them over the [Model Context Protocol](https://modelcontextprotocol.io), calls them, reads the real results, and answers from them. When it wants to change something, it stops and asks.

---

## What it does

Give it a symptom:

> *Which deployments failed for checkout-api? Use your tools to find out and explain the cause.*

and it does this, live:

```
list_deployments  { service: "checkout-api" }
  → dep_1914063509_1  checkout-api/production  failed (a1c93f2)
get_deployment    { deploymentId: "dep_1914063509_1" }
  → rolled out to 1/3 replicas then rolled back · health check failed (HTTP 503)
get_ci_failure    { runId: "run_4821" }
  → failed at test/unit-tests · 3 assertions failed in checkout/cart.spec.ts
list_issues       { state: "open" }
  → #412 "Checkout total rounds up to the wrong amount" (bug, checkout, regression)
```

and then it tells you the cause — that the failed assertions are the same
bug as open issue #412, and that the deployment was rolled back because
the health check failed. Three tools, chained, each one fed by the last.

Then it asks before it acts:

```
Create branch (name="fix/checkout-rounding", baseBranch="main")
  CONSEQUENTIAL — Approval required
   [ Approve & run ]  [ Cancel ]
```

The branch is created **only** if you approve, and only with exactly the
arguments you were shown.

---

## Why it is built this way

**MCP is the point, not a wrapper.** Muca is a real MCP server. Any MCP
client — Claude Desktop, Amazon Q, anything — can connect to
`/api/v1/mcp` and use its seventeen tools. The web page is just one client of
it, and it shows its own live session so you can see the protocol
traffic rather than take it on trust.

**Safety is the feature.** An approval is a statement about a *specific
action*, not permission to use a tool. Muca records the tool **and the
exact arguments** you saw, compares them canonically, and consumes the
approval once. A later call to the same tool with different arguments is a
different action and asks again. A call id the server never issued
authorises nothing. The model cannot talk its way past any of this — the
decision is made by the server, from the tool being called.

**It works with whatever key you have.** Anthropic, OpenAI and Gemini are
configured from the environment, **probed in parallel at startup** with a
real request, and the highest-priority one that answers is used
(anthropic > openai > gemini). A rate-limited key still counts as valid.
If none of them answer, the server still boots: the MCP server, the tool
catalogue and the scripted demo all work without a model.

**One process, one port.** The Express server hosts the API, the MCP
endpoint and the Next.js frontend together on `8099`. No second port, no
proxy, no separate dev server.

---

## Quick start

```bash
npm install
cp .env.example .env      # then put a key in ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY
npm run dev
```

Open <http://localhost:8099/>.

The server prints what it decided:

```
  Muca — Amazon Developer Hackathon 2026 (Alexa+ track)
  ---------------------------------------------------
  Frontend   http://localhost:8099/
  REST API   http://localhost:8099/api/v1
  MCP        http://localhost:8099/api/v1/mcp
  Protocol   2025-11-25
  AI gateway  auto → anthropic (claude-sonnet-4-5)  probes: anthropic ok 1180ms · openai not_configured · gemini throttled 922ms
```

**No API key is fine.** The MCP server works, the tools are published, and
the web UI offers a clearly-labelled scripted demo.

### Verify the MCP handshake yourself

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'probe', version: '0.1.0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8099/api/v1/mcp')));

console.log(client.getServerVersion());      // { name: 'muca-mcp', version: '0.2.0' }
console.log(client.getServerCapabilities()); // { tools: …, tasks: … }
console.log((await client.listTools()).tools.map((t) => t.name));
await client.close();
```

---

## The tools

Declared once, in `apps/server/src/tools/catalogue.ts`. The MCP layer and
the REST layer both derive from it, so they cannot drift apart.

| Tool | Writes | Destructive | Purpose |
|---|---|---|---|
| `echo` | no | no | Proves a tool-call round trip |
| `list_deployments` | no | no | Recent deployments per service, with status, commit and log tail |
| `get_deployment` | no | no | One deployment, with its CI run and log tail |
| `get_ci_failure` | no | no | The failing job, step, error and log excerpt |
| `list_issues` | no | no | Issues by state, with labels |
| `create_issue` | **yes** | no | Opens an issue from the diagnosis |
| `comment_on_issue` | **yes** | no | Adds the evidence to an existing issue |
| `create_branch` | **yes** | **yes** | Creates the fix branch — needs approval |
| `open_pull_request` | **yes** | **yes** | Opens the PR with the fix — needs approval |
| `diagnose_incident` | no | no | **Task-backed**: correlates deployment + CI + issue, returns a diagnosis |
| `get_pull_request` | no | no | One pull request: state, files, the diff, the review summary, the checks |
| `list_pull_request_reviews` | no | no | The reviews: who, and what they asked for |
| `list_pull_request_comments` | no | no | The review comments: file, line, body, resolved or not |
| `list_workflow_runs` | no | no | The CI runs for a branch: green, failed (with the job and the log), queued |
| `list_commits` | no | no | Recent commits, and the files each one touched |
| `push_commit` | **yes** | no | Pushes a change to the branch — the diff, the commits and the CI all update |
| `reply_to_review` | **yes** | no | Answers a reviewer and resolves their comment |

`readOnlyHint` and `destructiveHint` are published honestly: eleven tools
are read-only, six write, and exactly two are consequential.

### The loop closes

Muca does not stop at "here is a pull request". It can read the pull
request, read the review that asked for a change, **push the fix**, answer
the reviewer, and check whether the CI went green:

```
get_pull_request      → PR #700, the files it changes, the diff, the checks
list_pull_request_reviews
                      → "changes_requested: this loads the customer twice —
                         it is already on the session"
push_commit           → the branch changes; the diff is recomputed, the
                         commit list grows, the CI runs re-queue
reply_to_review       → the comment becomes resolved
list_workflow_runs    → the runs are queued, then green
```

The diff is **computed**, not written down: the mock holds the file
contents of each branch and derives a real unified diff from them, so
pushing the fix genuinely removes the offending hunk.

`diagnose_incident` uses the MCP **Tasks** API: it returns a task handle
immediately and the client polls `tasks/get` until it reaches a terminal
state.

---

## Configuration

Everything lives in `.env` (see `.env.example`). Nothing is hardcoded, and
`.env` is git-ignored.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8099` | The single port for the frontend, the API and MCP |
| `AI_PROVIDER` | `auto` | `auto` \| `anthropic` \| `openai` \| `gemini` \| `bedrock` |
| `AI_PROBE_TIMEOUT_MS` | `10000` | Deadline for a single provider probe |
| `ANTHROPIC_API_KEY` / `_ENDPOINT` / `_MODEL` | — | Anthropic (Messages API) |
| `OPENAI_API_KEY` / `_ENDPOINT` / `_MODEL` | `gpt-4o-mini` | OpenAI, or any OpenAI-compatible endpoint |
| `GEMINI_API_KEY` | — | Google Gemini (`generateContent`) |
| `BEDROCK_MODEL_ID` | — | AWS Bedrock, via the standard AWS credential chain |
| `MCP_PROTOCOL_VERSION` | `2025-11-25` | Protocol version advertised by the server |
| `MCP_PUBLIC_URL` | `http://localhost:${PORT}/api/v1/mcp` | Public URL of the MCP endpoint |
| `MUCA_DATABASE_PATH` | `~/.adh/database/muca.db` | Where sessions, events and policies are stored |
| `CONTEXT_COMPACTION_THRESHOLD` | `0.8` | Compact the conversation at this fraction of the model's input limit |
| `CONTEXT_KEEP_TURNS` | `3` | How many recent turns compaction keeps verbatim |

---

## Architecture

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

Three concerns, kept apart on purpose:

| Layer | Where | Responsibility |
|---|---|---|
| Transport | `apps/server/src/mcp/` | MCP session lifecycle, protocol negotiation, tasks, elicitation |
| Tool execution | `apps/server/src/tools/` | Schemas, validation, business behaviour |
| AI orchestration | `apps/server/src/ai/` | The tool-calling loop, the provider gateway, the approval gate |

The agent loop talks to the **tool catalogue**, not to the MCP transport.
The MCP server and the REST API are two front doors onto the same tools.

---

## Testing

```bash
npm test          # 286 tests: 260 backend + 26 frontend
npm run typecheck
npm run lint
npm run build
```

| Area | What it proves |
|---|---|
| MCP protocol | `initialize`, capability negotiation, session id, `tools/list` with honest annotations, `tools/call` validation, clean errors, session teardown |
| Elicitation | A real client is asked, and a client without the capability is refused — **fail closed** |
| MCP Tasks | A task handle is returned, polled, and reaches a terminal state with a result |
| Approval safety | An approval authorises one *action*, not one tool; a fabricated id authorises nothing; a spent approval cannot be replayed |
| AI gateway | Parallel probes, priority selection, 429 usable / 401 not, timeouts, no key leakage |
| Provider adapters | Anthropic and Gemini map the whole conversation, including tool calls and tool results |
| Frontend | The parser and the timeline, including the parked / cancelled / approved / errored cases |

The MCP tests use the **real** SDK client against a **real** HTTP server.
The provider tests inject a fake `fetch`, so the suite never touches the
network.

---

## Layout

```
apps/
  server/                 Express + MCP + agent loop + gateway
    src/
      ai/                 agent loop, provider adapters, gateway, approval gate
      http/               REST routes
      mcp/                MCP server, transport, tasks, elicitation
      store/              run history, pending approvals
      tools/              catalogue + the Ops Copilot tool implementations
    tests/
  web/                    Next.js + React + Tailwind
    app/                  app router + components
    lib/                  API client, MCP client, timeline, demo
AGENTS/                   one folder per agent: task briefs and summaries
```

---

## What is real, and what is not

Being straight about this, because it matters more than a feature list.

- **The MCP server is real.** A standard Streamable HTTP endpoint, the
  official SDK, protocol `2025-11-25`, with Tasks and Elicitation
  genuinely used. Any MCP client can connect to it.
- **The agent loop is real.** It calls tools, reads the results, feeds
  them back, and grounds its answer in them. The screenshots and the test
  suite are of the real thing, not a mock.
- **The ops world is a seeded mock.** The deployments, CI runs and issues
  are deterministic in-memory fixtures, not your GitHub. The adapter seam
  (`OpsAdapters`) is where a real provider goes; everything above it
  already works.
- **Muca is not integrated with Alexa+.** It ships as a web client. No
  Alexa integration is claimed.
- **There is no authentication.** The API and the MCP endpoint are open,
  by choice, for a local demo. Do not expose it to a public network
  without adding authentication.
- **Run history is a JSON file per run**, not a database. It survives a
  restart, which is enough for a demo, and it is not a real store.

## In progress

- A live WebSocket channel that streams the agent's run as it happens,
  with per-session sequence numbers and replay, so a dropped connection
  never loses a frame.
- SQLite persistence for sessions, in `~/.adh/database/`.
- A user-editable **policy engine**: rules that decide whether a tool may
  run, so "always ask before opening a pull request" is a setting rather
  than a hardcoded rule.
- Detached prompting: the agent can ask you a question and wait.

---

## Licence

MIT.
