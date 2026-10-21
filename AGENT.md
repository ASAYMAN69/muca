# Muca — Coordinator & Delegation Protocol

> **Before starting any task or marking any task completed, read this entire
> file carefully and keep every task updated to match the task condition.
> Always read this file after completing a task and always update it before
> working on a new task.**

<agent-topology>

The user is the **COORDINATOR / PLANNER**. The main agent in this
conversation is the **HEAD agent** (planning, task authoring, review,
integration, commits). All other agents are separate **MAIN agents**, each in
its own session and working directory. They are **NOT** the `subagent` tool.

| Agent | Working directory | Owns |
|---|---|---|
| HEAD | `/mnt/ee/aprojects/zyrun/adh` | Planning, task files, review, integration, commits |
| FRONTEND | `/mnt/ee/aprojects/zyrun/adh/apps/web` | `apps/web` implementation only |
| BACKEND | `/mnt/ee/aprojects/zyrun/adh/apps/server` | `apps/server` implementation only |
| TESTER | `/mnt/ee/aprojects/zyrun/adh` | Independent verification of shipped changes; no product edits |

The user relays the HEAD's invocation message. The HEAD explicitly tells the
user WHEN to invoke which agent and the exact message to send. Repo agents
never commit/push; the HEAD reviews and commits.

- FRONTEND/BACKEND task lifecycle: HEAD writes
  `apps/<repo>/AGENT/TASK.md`; user relays "Read
  `apps/<repo>/AGENT/TASK.md` and complete it."; the agent works, writes
  `apps/<repo>/AGENT/SUMMARY.md`, renames `TASK.md` to `TASK-COMPLETE.md`.
  HEAD archives the summary, resets the marker, and writes the next task.
- TESTER reads `AGENTS/TESTER.md` and writes reports to
  `AGENTS/TEST_REPORTS/`.

See `AGENTS/repo_agent_protocol.md` and `AGENTS/TESTER.md`.

</agent-topology>

<instructions>

- Agent topology (HARD RULE): the user is the coordinator/planner; the main
  agent is the HEAD agent. `apps/web`, `apps/server` and TESTER are separate
  MAIN agents in their own sessions; they are **NOT** the `subagent` tool and
  never share a session. The HEAD translates user intent into
  self-contained tasks, tells the user exactly which agent to invoke and what
  to say, reviews the result, and commits. Repo agents never commit/push.
  See `AGENTS/repo_agent_protocol.md`.
- Delegation-first (HARD RULE): the HEAD should get ~99% of work done by
  agents, not by itself. HEAD only plans, writes task/prompt files, reads
  summaries, reviews diffs, runs integration checks too small to delegate,
  and commits. Product code goes to FRONTEND/BACKEND. Verification goes to
  TESTER. If the HEAD feels the remaining work is too heavy, it must tell the
  user and ask permission to delegate an additional agent.
- Invocation protocol: when an agent is needed, HEAD outputs a short
  `INVOKE: <AGENT>` block with the exact copy-paste message, then stays
  terse while the agent runs. HEAD gives its full assessment only after the
  agent returns. Never silently start work that should be delegated.
  - FRONTEND and BACKEND may run **in parallel** when the task contract is
    already fixed and neither depends on the other's output.
  - TESTER is invoked after any frontend/backend code change is ready for
    review, and after any bug fix. Scope is mandatory (feature + obvious
    regressions).
- TESTER runs at the workspace root, reads both apps, writes reports to
  `AGENTS/TEST_REPORTS/`, and never edits product code, `.env`, or commits.
- Each repo agent owns an isolated, persistent session context. It persists
  natively between tasks; the agent does not need a per-task memory file.
  `AGENT/SUMMARY.md` is the HEAD handoff. Agents must not rely on the user
  chat; every task is self-contained.
- **Single port (HARD RULE):** the Express server in `apps/server` hosts the
  Next.js app in `apps/web` and the API under `/api/v1`. `PORT=8099`. The
  browser only ever calls relative `/api/v1` paths. Never introduce a second
  port, a Vite proxy, a separate frontend dev server, or an absolute
  backend URL in the client bundle.
- **API prefix (HARD RULE):** the REST API lives under `/api/v1`. The MCP
  endpoint is `/api/v1/mcp`. Never move either without a HEAD task.
- **No hardcoded hosts, ports or credentials:** configuration lives in
  `.env` (template in `.env.example`). No `|| 'localhost:3000'` style
  fallbacks in source.
- **Secrets:** never commit `.env`, API keys or tokens. `.env*` is
  git-ignored except `.env.example`.
- **MCP contract (HARD RULE):** the server is `@modelcontextprotocol/sdk`
  pinned to an exact version, Streamable HTTP, stateful sessions, protocol
  `2025-11-25`. Tools are declared with Zod schemas in
  `apps/server/src/tools/`. Changing the SDK version means re-verifying
  protocol compatibility — see `AGENTS/mcp_protocol.md`.
- **Separation of concerns (HARD RULE):** transport, tool execution and AI
  orchestration stay in separate modules. The agent loop must not import the
  MCP transport; it talks to the `ToolRegistry`.
- **Destructive tools require user confirmation:** any tool that changes
  state irreversibly is registered with `destructive: true` and the agent
  must not run it without an approved call id.
- **Error handling (HARD RULE):** validate all tool arguments with Zod;
  never let a tool throw an unhandled rejection into the request. Tool
  failures return an error result, not a 500.
- **Verification:** use the repo check scripts; run `npm test` and
  `npm run typecheck` from the workspace root. Do not run a full production
  build for routine checks.
- No secrets or large code blocks in any agent file.

</instructions>

<projectInfo>

- [2026-10-21T14:05:00+06:00] **Skeleton shipped.** The repository is
  restructured into an npm-workspaces monorepo: `apps/server` (Express + MCP
  + agent loop) and `apps/web` (Next.js 16 + React 19 + Tailwind 4). One
  process, one port (`8099`): Express mounts the REST API and the MCP
  Streamable HTTP endpoint under `/api/v1` and delegates everything else to
  the Next.js request handler.

  Verified working:
  - MCP `initialize` handshake over real HTTP with a real SDK client;
    `serverInfo` = `muca-mcp 0.1.0`, capabilities = `{tools:{listChanged:true}}`.
  - `tools/list` returns 7 tools with JSON Schema input schemas and
    `destructiveHint` annotations (`delete_note`, `clear_notes` are destructive).
  - `tools/call` executes, validates arguments (invalid input ⇒ `isError`
    with a Zod message), and preserves state across calls in a session.
  - `GET /api/v1/health`, `GET /api/v1/tools`, `POST /api/v1/chat` all respond
    correctly; `GET /` returns 200 with the Next.js app.
  - 21 backend tests pass (`npm test`): MCP protocol, tool discovery,
    tool execution, agent tool-calling loop, REST API.
  - `npm run typecheck` is clean for both workspaces.

  Key decisions:
  - `@modelcontextprotocol/sdk` pinned to `1.32.1`; `LATEST_PROTOCOL_VERSION`
    in that release is `2025-11-25`, which is the advertised version.
  - Zod unified on `4.6.7` via a root `overrides` entry. Without it npm
    installed both zod 3.25.76 and 4.6.7, and the SDK's
    `zod-to-json-schema` import failed at runtime. This is a real trap.
  - `next` is hoisted to the workspace root, so `apps/web/next.config.ts`
    sets `turbopack.root` to the workspace root. Without it Turbopack fails
    with "Could not find the Next.js package".
  - `next` is a CJS module whose export *is* the factory function, so the
    server imports it as `nextModule.default` and casts it.

  **Status:** the use case is NOT finalised. The seven tools in
  `apps/server/src/tools/index.ts` are placeholders that prove the pipeline.
  The next milestone is the real use case, then its tools.

</projectInfo>
