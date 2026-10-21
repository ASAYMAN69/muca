# AGENTS/ — the agent task channel

Every agent has **its own folder**. A task for one agent never lives in
another agent's folder, and a summary never crosses over. This file is the
map.

| Agent | Folder | Product code it owns | Session |
|---|---|---|---|
| **BACKEND** | `AGENTS/BACKEND/` | `apps/server` | own, persistent |
| **FRONTEND** | `AGENTS/FRONTEND/` | `apps/web` | own, persistent |
| **TESTER** | `AGENTS/TESTER/` | none — read-only | own, persistent |

Read-only / shared docs (nobody's private folder):

| File | Purpose |
|---|---|
| `PLAN.md` | Strategy, judging axes, phases, open decisions. |
| `repo_agent_protocol.md` | The task lifecycle and repo boundaries. |
| `mcp_protocol.md` | Pinned protocol versions, the zod trap, the session contract. |
| `TESTER.md` | TESTER's scope, report format, severity rules. |
| `TEST_REPORTS/` | TESTER's reports, one file per round. |

## What is in each agent folder

```
AGENTS/<AGENT>/
├── README.md          # what this folder is, and the rules
├── TASK.md            # the task in flight          (coordinator writes)
├── TASK-COMPLETE.md   # TASK.md renamed when done   (agent writes)
├── SUMMARY.md         # the handoff report          (agent writes)
└── summaries/         # archived rounds, YYYY-MM-DD-<slug>.md
```

`TASK.md` and `TASK-COMPLETE.md` are never both present.

## The rule

- **The coordinator** writes `AGENTS/<AGENT>/TASK.md` and archives finished
  rounds into `AGENTS/<AGENT>/summaries/`.
- **The agent** writes only `AGENTS/<AGENT>/SUMMARY.md`, renames its own
  `TASK.md` → `TASK-COMPLETE.md`, and never touches another agent's folder.
- **Product code stays in the app.** `AGENTS/<AGENT>/` is the task and
  summary channel only — no source files, no build output.
- **Never commit.** The coordinator reviews and commits.

## Dispatching

The user is the relay. The exact message to send an agent is:

> Read `AGENTS/<AGENT>/TASK.md` and complete it.

For a fresh session, prefix it with the agent's own docs:

> Read `apps/<app>/AGENT.md`, then `AGENTS/<AGENT>/README.md`, then
> `AGENTS/<AGENT>/TASK.md` and complete it.
