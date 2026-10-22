# Muca Server — App Agent Instructions

## 0. Who you are

- You are a **MAIN agent** in your own session, owning `apps/server` only.
- You are **not a subagent**. Do not use `sub-agent/` directories, per-agent
  markers, or cross-session message files.
- The user talks to the **system coordinator** (the HEAD agent). The
  coordinator writes `AGENTS/BACKEND/TASK.md`; the user tells you to read it.
- Never edit `apps/web` or the workspace root. If a task needs the other
  app, **stop** and report it in `AGENTS/BACKEND/SUMMARY.md`; the coordinator will
  create a counterpart task.

## 1. Session start checklist

1. If this is a fresh session, read `AGENT.md` (this file). Your context
   persists between tasks, so you normally do not need to re-read it.
2. Check `AGENTS/BACKEND/TASK.md` and `AGENTS/BACKEND/TASK-COMPLETE.md`:
   - If `TASK-COMPLETE.md` exists and `TASK.md` does not, the previous task
     is still marked complete. **Stop** and tell the user the coordinator
     must reset it before you can work.
   - If neither exists, wait for the coordinator.
3. Read `AGENTS/BACKEND/TASK.md` and work only that task.
4. Do not infer requirements from the user chat. The task file is the source
   of truth.

## 2. Task completion protocol

1. Implement within the task's scope. Stay inside `apps/server`.
2. Verify (see §5). Record exact commands and results.
3. Overwrite `AGENTS/BACKEND/SUMMARY.md` with the task summary (see §4).
4. Rename `AGENTS/BACKEND/TASK.md` → `AGENTS/BACKEND/TASK-COMPLETE.md`.
5. Tell the user the task is complete and point to `AGENTS/BACKEND/SUMMARY.md`.

Do not rename `TASK-COMPLETE.md` back yourself; the coordinator resets it.

## 3. Project context

**Product.** Muca is an AI agent for the Amazon Developer Hackathon 2026
(Alexa+ track, Option A: self-hosted MCP server). It uses MCP tools to do
real work. It has **no Alexa+ integration** — do not claim otherwise.

**Stack.** TypeScript (ESM, `NodeNext`), Node 20+, Express 5,
`@modelcontextprotocol/sdk@1.32.1` (pinned), Zod 4.6.7, OpenAI SDK 5,
Vitest.

**One process, one port.** This app owns the Express server. It serves:
- `/api/v1/mcp` — the MCP Streamable HTTP endpoint
- `/api/v1/ws` — the live WebSocket (one socket per session)
- `/api/v1/*` — the REST API
- `/*` — the Next.js frontend, mounted programmatically from `apps/web`

`PORT=8099`. Never add a second port, a Vite proxy, or a separate frontend
dev server.

**The database.** One global SQLite file at `~/.adh/database/muca.db`, via
`node:sqlite`. It holds the sessions, the messages, the event log, the
runs, the approvals, the outstanding requests and the policies. The tests
always use a temporary path — never the user's real database.

**Layout.**

```
src/
├── ai/
│   ├── provider.ts        # AIProvider interface + neutral message types
│   ├── stream.ts          # the streaming shape every provider speaks
│   ├── sse.ts             # the server-sent-events parser
│   ├── openai-provider.ts # OpenAI adapter
│   ├── anthropic-provider.ts
│   ├── gemini-provider.ts
│   ├── agent.ts           # the tool-calling loop
│   ├── compaction.ts      # summarising a long conversation
│   ├── context-limits.ts  # the model's input limit
│   └── prompt.ts          # the system prompt
├── http/
│   ├── api.ts             # REST routes
│   ├── sessions-api.ts    # the session routes
│   └── policies-api.ts    # the policy routes
├── live/
│   ├── frames.ts          # the live protocol's frames
│   ├── hub.ts             # the sessions, the sequence numbers, the replay
│   ├── ws-server.ts       # the socket at /api/v1/ws
│   ├── run.ts             # one live run
│   ├── policy-gate.ts     # the server-side permission decision
│   └── service.ts         # the wiring
├── mcp/
│   ├── server.ts          # McpServer + tool registration
│   ├── http-handler.ts    # Streamable HTTP transport + session lifecycle
│   └── client.ts          # a real MCP client for self-checks
├── policy/
│   ├── engine.ts          # the policy engine
│   └── matchers.ts        # the argument matchers
├── store/
│   ├── db.ts              # the SQLite schema
│   └── index.ts           # the stores, one per concern
├── tools/
│   ├── registry.ts        # ToolRegistry + MucaTool
│   ├── catalogue.ts       # the one tool declaration
│   ├── ask-user.ts        # the question tool (the live path only)
│   └── index.ts           # the actual tools
├── config.ts              # env parsing
├── paths.ts               # repo-root discovery + .env loading
├── server.ts              # the Express app
└── index.ts               # entrypoint
```

**Hard rules.**

- **Separation of concerns.** The agent loop imports `ToolRegistry`, never
  the MCP transport. The MCP server and the REST API are two front doors
  onto the same registry.
- **Zod is unified at `4.6.7` via a root `overrides` entry.** Changing it
  breaks the SDK at runtime — read `AGENTS/mcp_protocol.md`.
- **Destructive tools** are registered with `destructive: true`. The agent
  must not run them without an approved call id.
- **All tool arguments are validated** with Zod at the call boundary. A tool
  failure returns an error result; it never throws into the request.
- **No hardcoded hosts, ports or credentials.** Config comes from `.env`.
- **Secrets.** Never commit `.env`; never log API keys.
- **`next` is a CJS module** whose export *is* the factory function. The
  server imports it as `nextModule.default` and casts it. `next` is hoisted
  to the workspace root, so `apps/web/next.config.ts` sets
  `turbopack.root` to the workspace root.

## 4. Summary format

```markdown
# Summary — <task title>
**Status:** complete | blocked | partial
**Date:** YYYY-MM-DD

## What changed
- file → what/why

## Verification
- command → result (pass/fail, key output)

## Decisions / trade-offs
- ...

## Follow-ups / risks
- ...
```

## 5. Verification

From the workspace root `/mnt/ee/aprojects/zyrun/adh`:

```bash
npm test --workspace @muca/server        # the vitest suite
npm run typecheck --workspace @muca/server
npm run lint --workspace @muca/server
```

A production build (`npm run build --workspace @muca/server`) is only needed
when the task explicitly says so.

To run the server locally:

```bash
npm run dev --workspace @muca/server
```

If you need an API key, use a dummy one for anything that does not make a
real model call. Never write a real key into a script, a test, or a report.

## 6. Testing conventions

- The MCP tests use the **real** SDK client against a **real** HTTP server.
  Keep it that way — do not stub the transport.
- `apps/server/tests/` mirrors the source layout: `mcp-protocol.test.ts`,
  `agent.test.ts`, `api.test.ts`.
- `McpHttpHandler` uses the raw Node response API (`res.writeHead` /
  `res.end`) rather than `res.status().json()`, so it works behind a bare
  `http.createServer`. Keep it that way.
- The agent loop is tested with a `ScriptedProvider` that returns a
  pre-written list of responses. That is the right level of abstraction:
  the transport is real, the model is not.
