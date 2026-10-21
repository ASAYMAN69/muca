# Repo Agent Protocol — Coordinator + Per-Repo Main Agents

> **Standing architecture.** The user talks to one **system coordinator**
> (the main agent in the user's conversation). `apps/web` and `apps/server`
> are each owned by a **separate main agent in its own session**. They are
> **not subagents** and do not share a session with the coordinator or with
> each other. All coordination happens through files inside the repo.

## 1. Roles

| Role | Owns | Talks to |
|---|---|---|
| **User** | Product intent / priorities | Coordinator |
| **Coordinator** (main agent in the user's chat) | Cross-repo planning, task authoring, integration, review | User; writes repo task files |
| **Frontend repo agent** (main agent in its own session) | `apps/web` only | User (relays task), repo files |
| **Backend repo agent** (main agent in its own session) | `apps/server` only | User (relays task), repo files |

Rules:

- The repo agents **never** edit the other app, the workspace root, or each
  other's `AGENT/` files.
- The coordinator **never** assumes a repo agent can see the user
  conversation. Every task must be self-contained.
- The user is the relay: the coordinator writes the task; the user tells the
  repo agent to read it. The coordinator reads the summary from disk.
- The repo agents are **main agents**, not subagents.

## 2. File layout

Every agent gets **its own folder**, at the workspace root, under `AGENTS/`.
Tasks and summaries for one agent never share a folder with another agent.

```
AGENTS/
├── INDEX.md                     # who owns which folder
├── PLAN.md, repo_agent_protocol.md, mcp_protocol.md, TESTER.md
├── BACKEND/
│   ├── README.md                # what this folder is, and the rules
│   ├── TASK.md                  # the task in flight (coordinator writes)
│   ├── TASK-COMPLETE.md         # TASK.md renamed when the task is done
│   ├── SUMMARY.md               # the handoff report (agent writes)
│   └── summaries/               # archived summaries, one file per round
├── FRONTEND/                    # same five entries
└── TESTER/                      # same five entries
```

Rules:

- **One agent, one folder.** BACKEND reads and writes only
  `AGENTS/BACKEND/`; FRONTEND only `AGENTS/FRONTEND/`; TESTER only
  `AGENTS/TESTER/`. Never write another agent's folder.
- The agent's product code still lives in its app (`apps/server`,
  `apps/web`). The `AGENTS/<AGENT>/` folder is only the **task and
  summary channel**, not a place for source.
- Archived summaries are named `summaries/YYYY-MM-DD-<task-slug>.md` so a
  round can be found by date without opening every file.

## 3. Task lifecycle

1. **Reset (coordinator).** If `AGENTS/<AGENT>/TASK-COMPLETE.md` exists, the
   coordinator reads `SUMMARY.md`, archives both to
   `AGENTS/<AGENT>/summaries/`, and removes `TASK-COMPLETE.md`. This must
   happen **before** writing a new task.
2. **Author (coordinator).** The coordinator overwrites
   `AGENTS/<AGENT>/TASK.md` with a self-contained task (template below).
3. **Dispatch (user).** The user tells the agent: "Read
   `AGENTS/<AGENT>/TASK.md` and complete it." (The agent also reads its own
   `AGENTS/<AGENT>/README.md` and `apps/<app>/AGENT.md` first.)
4. **Execute (repo agent).** Work only inside the assigned app.
5. **Verify (repo agent).** Run the task's verification commands plus the
   repo check suite; record the exact results.
6. **Report (repo agent).** Overwrite `AGENTS/<AGENT>/SUMMARY.md`, then
   rename `AGENTS/<AGENT>/TASK.md` → `AGENTS/<AGENT>/TASK-COMPLETE.md`.
7. **Integrate (coordinator).** Read `SUMMARY.md`, review the diff, commit
   and push when satisfied, then prepare the next task.

If `TASK.md` is absent and `TASK-COMPLETE.md` exists, the repo agent must
stop and tell the user the coordinator needs to reset the task file.

## 4. Task file template

```markdown
# <Task title>

> **Before starting:** if this is a fresh session, read `AGENT.md` in this
> app; otherwise rely on your persistent context. Then read this task. The
> task is self-contained; do not infer from the user chat.

**App:** web | server
**Assigned by:** coordinator
**Date:** YYYY-MM-DD

## Goal
One paragraph: the user-visible outcome.

## Why / context
Project context the repo agent needs. Do not assume it saw the user chat.

## Scope
Exact files/directories to change. Explicitly list out-of-scope areas.

## Requirements
- Concrete, testable requirements.
- Data/contract details (payloads, endpoints, field names).
- Compatibility notes.

## Constraints
- App boundaries (never edit the other app or the workspace root).
- The standing rules in the root `AGENT.md`.
- Do not commit or push; the coordinator pushes after reviewing the summary.

## Acceptance criteria
- [ ] Observable behaviour.
- [ ] Tests/checks that must pass.
- [ ] No regressions in nearby flows.

## Verification
Exact commands, e.g.:
- `npm run typecheck --workspace @adh/web`
- `npm test --workspace @muca/server`
- `npm run build` only when the task explicitly asks for it.

## Out of scope
What the agent must not do.

## Notes
Links to relevant docs, known gotchas (see `AGENTS/mcp_protocol.md`).
```

## 5. Summary file format

```markdown
# Summary — <task title>
**Status:** complete | blocked | partial
**Date:** YYYY-MM-DD

## What changed
- file → what/why (bullet per file or group)

## Verification
- command → result (pass/fail, key output)

## Decisions / trade-offs
- ...

## Follow-ups / risks
- Anything the coordinator must schedule in the other app, or open
  questions.
```

## 6. Session context (persistent, isolated, no memory file)

Each repo agent owns a **persistent, isolated session context**. It lives in
that agent's own session; it is separate from the coordinator's context and
from the other repo agent's context. It persists between tasks. The agent
does **not** need to read a context memory file every task.

`AGENT.md` is the permanent written instruction. `SUMMARY.md` is the only
required handoff to the coordinator. Never put secrets, tokens, credentials
or large code blocks in any file.

## 7. Coordinator responsibilities

- Translate the user's intent into **app-specific, self-contained** tasks.
- Split cross-app features into ordered tasks (server contract first when
  needed, then web), with explicit contracts in each task.
- Include exact paths, payloads, acceptance criteria and verification.
- Review each `SUMMARY.md` and the diff, then **commit** when satisfied.
- Reset `TASK-COMPLETE.md` → `TASK.md` before assigning the next task.
- Never ask a repo agent to infer requirements from the user chat.

## 8. Repo-agent boundaries

- Work only in the assigned app. If a task requires the other app, **stop**
  and report it in `SUMMARY.md`; the coordinator will create a counterpart
  task.
- **Do not run `git commit` or `git push`.**
- No subagents; you are a main agent in your own session.
- No edits to `AGENT.md` unless the task explicitly says so. You may edit
  `AGENTS/<AGENT>/SUMMARY.md` and rename `TASK.md`.
- Report blockers, environment failures and cross-app dependencies in
  `SUMMARY.md`; do not silently guess.

## 9. Standing project rules that every task inherits

- **One port.** `PORT=8099`. Express hosts the Next.js app and the API. The
  browser only calls relative `/api/v1` paths. No second port, no Vite
  proxy, no absolute backend URL in the client bundle.
- **API under `/api/v1`**, MCP at `/api/v1/mcp`. Do not move either without
  a coordinator task.
- **No hardcoded hosts, ports or credentials.** Config lives in `.env`.
- **MCP contract.** SDK pinned to an exact version, Streamable HTTP,
  stateful sessions, protocol `2025-11-25`. See `AGENTS/mcp_protocol.md`.
- **Separation of concerns.** Transport, tool execution and AI
  orchestration stay separate. The agent loop must not import the MCP
  transport.
- **Destructive tools need confirmation** — registered with
  `destructive: true` and gated by an approved call id.
- **Error handling.** Validate all tool arguments with Zod. Tool failures
  return an error result, never an unhandled rejection.
- **Secrets.** Never commit `.env` or secrets; never log tokens.
- **Verification.** `npm test` and `npm run typecheck` from the workspace
  root. No full production build for routine checks.
