# AGENTS/BACKEND — task channel for the BACKEND agent

This folder is the handoff channel between the **coordinator** (HEAD agent)
and the **BACKEND agent**, which owns `apps/server`.

It is not a place for source code. Product code lives in `apps/server`.

| File | Who writes it | Meaning |
|---|---|---|
| `TASK.md` | Coordinator | The current, self-contained task. **Only one at a time.** |
| `SUMMARY.md` | BACKEND agent | The report for the task that just finished. |
| `TASK-COMPLETE.md` | BACKEND agent | `TASK.md` renamed after the task is done. |
| `summaries/` | Coordinator | Archived rounds, `YYYY-MM-DD-<slug>.md`. |

## Rules

1. Read `apps/server/AGENT.md` once, then `TASK.md`. The task file is the
   source of truth — never infer requirements from the user chat.
2. Work **only** inside `apps/server`. Never edit `apps/web`, the workspace
   root, or `AGENTS/FRONTEND/` / `AGENTS/TESTER/`.
3. Overwrite `SUMMARY.md`, then rename `TASK.md` → `TASK-COMPLETE.md`.
   Never rename it back.
4. If a task needs a change outside `apps/server`, **stop** and say so in
   `SUMMARY.md` instead of making it.
5. Never run `git commit` or `git push`.

The full protocol is in `AGENTS/repo_agent_protocol.md`.

## Rounds

| Date | Task | Summary |
|---|---|---|
| 2026-10-21 | Placeholder tools → Ops Copilot tool set, Elicitation, MCP Tasks, Bedrock, run history | `summaries/2026-10-21-protocol-native-upgrade.md` |
| 2026-10-21 | P1: bind the HTTP approval to the parked action | `SUMMARY.md` / `TASK-COMPLETE.md` |
