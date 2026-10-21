# AGENT/ — task protocol folder

This folder is the handoff channel between the **coordinator** (HEAD agent)
and the **app agent** that owns this app.

| File | Who writes it | Meaning |
|---|---|---|
| `TASK.md` | Coordinator | The current, self-contained task. **Only one at a time.** |
| `SUMMARY.md` | App agent | The report for the task that just finished. |
| `TASK-COMPLETE.md` | App agent | `TASK.md` renamed after the task is done. |
| `summaries/` | Coordinator | Archived past summaries. |

## Rules

1. The app agent reads `AGENT.md` (in the app root) once, then reads
   `TASK.md`. The task file is the source of truth — never infer
   requirements from the user chat.
2. The app agent works **only** inside its own app directory.
3. The app agent overwrites `SUMMARY.md`, then renames `TASK.md` to
   `TASK-COMPLETE.md`. It never renames it back.
4. The coordinator reads `SUMMARY.md`, reviews the diff, resets the marker
   (`TASK-COMPLETE.md` → `TASK.md`), and writes the next task.
5. The app agent **never** runs `git commit` or `git push`.

The full protocol is in `AGENTS/repo_agent_protocol.md` at the workspace
root.
