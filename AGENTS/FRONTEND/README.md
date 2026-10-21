# AGENTS/FRONTEND — task channel for the FRONTEND agent

This folder is the handoff channel between the **coordinator** (HEAD agent)
and the **FRONTEND agent**, which owns `apps/web`.

It is not a place for source code. Product code lives in `apps/web`.

| File | Who writes it | Meaning |
|---|---|---|
| `TASK.md` | Coordinator | The current, self-contained task. **Only one at a time.** |
| `SUMMARY.md` | FRONTEND agent | The report for the task that just finished. |
| `TASK-COMPLETE.md` | FRONTEND agent | `TASK.md` renamed after the task is done. |
| `summaries/` | Coordinator | Archived rounds, `YYYY-MM-DD-<slug>.md`. |

## Rules

1. Read `apps/web/AGENT.md` once, then `TASK.md`. The task file is the
   source of truth — never infer requirements from the user chat.
2. Work **only** inside `apps/web`. Never edit `apps/server`, the workspace
   root, or `AGENTS/BACKEND/` / `AGENTS/TESTER/`.
3. Overwrite `SUMMARY.md`, then rename `TASK.md` → `TASK-COMPLETE.md`.
   Never rename it back.
4. If a task needs a server change, **stop** and say so in `SUMMARY.md`
   instead of making it.
5. Never run `git commit` or `git push`.

The full protocol is in `AGENTS/repo_agent_protocol.md`.

## Rounds

| Date | Task | Summary |
|---|---|---|
| 2026-10-21 | Chat transcript → timeline, artifact cards, live MCP session panel, demo mode | `summaries/2026-10-21-round-1-summary.md` |
