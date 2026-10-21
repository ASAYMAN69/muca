# AGENTS/TESTER — task channel for the TESTER agent

This folder is the handoff channel between the **coordinator** (HEAD agent)
and the **TESTER agent**. TESTER owns no product code: it reads both apps
and writes reports.

| File | Who writes it | Meaning |
|---|---|---|
| `TASK.md` | Coordinator | The current verification request. **Only one at a time.** |
| `SUMMARY.md` | TESTER | The report for the verification just finished. |
| `TASK-COMPLETE.md` | TESTER | `TASK.md` renamed after the verification is done. |
| `summaries/` | Coordinator | Archived reports, `YYYY-MM-DD-<slug>.md`. |

Working reports go to `AGENTS/TEST_REPORTS/`, one file per round. A
`SUMMARY.md` here is the short verdict that points at the full report.

## Rules

1. Read `AGENTS/TESTER.md` (scope, report format, severity rules), then
   `TASK.md`.
2. **Read-only on product code.** Never edit `apps/**`, `.env`, or any
   config. A finding is written in the report, not fixed in place.
3. Never edit `AGENTS/BACKEND/` or `AGENTS/FRONTEND/`. Those are other
   agents' task channels.
4. Never run `git commit` or `git push`.

## Rounds

_None yet._ The first verification round is dispatched once BACKEND and
FRONTEND have both returned.
