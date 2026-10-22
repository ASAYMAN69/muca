# Cards for the fix loop: pull request, reviews, CI runs, commits

> **Before starting:** if this is a fresh session, read `apps/web/AGENT.md`,
> then `AGENTS/FRONTEND/README.md`. The task is self-contained; do not
> infer from the user chat.

**App:** web
**Assigned by:** coordinator
**Date:** 2026-10-22
**Deadline: 60 minutes. Work in the order below and cut from the bottom if
you run out of time.**

## Why

The BACKEND agent is adding seven tools in parallel: `get_pull_request`,
`list_pull_request_reviews`, `list_pull_request_comments`,
`list_workflow_runs`, `list_commits`, `push_commit`, `reply_to_review`.

Today the timeline renders a **generic** card for any result it does not
recognise. That is enough to see the tool call, but not enough for a demo:
the review that asked for a change and the CI run that failed are the two
moments the story turns on, and they must be legible at a glance.

## R1 — Pull request card

`lib/artifacts.ts` already has a per-tool card builder
(`buildSpecificCard`). Add:

- **`get_pull_request`** → the pull request: number, title, state, branch
  → base, author, the files it changes, and the **diff** in a monospace
  block. A diff that scrolls, and does not reflow.
- **`push_commit`** → the commit that was pushed: sha, message, the file
  that changed, and the diff it produced.

## R2 — Reviews

- **`list_pull_request_reviews`** → one row per review: the reviewer, the
  state (`approved` / `changes requested` / `commented`) **as a colour-coded
  badge**, and the body.
- **`list_pull_request_comments`** → one row per comment: the author, the
  file and line, the body, and a resolved / open marker.
- **`reply_to_review`** → a row that shows the reply and that the comment
  is now resolved.

## R3 — CI runs

- **`list_workflow_runs`** → one row per run: the workflow name, the
  branch, the status as a badge (`success` green, `failure` red,
  `running`/`queued` amber), and the failing job, step and log excerpt
  when it failed.

## R4 — Commits

- **`list_commits`** → a compact list: sha, message, author, the files it
  touched.

## Rules

- Follow the existing card conventions in `lib/artifacts.ts` and
  `app/components/artifact-card.tsx`. Match their type, spacing and
  badges. Do not invent a second style.
- A card for a tool you do not recognise must still render — the generic
  fallback stays.
- The tool descriptions come from `GET /api/v1/tools`; do not hardcode the
  tool list in the frontend.
- The cards must work in **both** themes and at **390px** without
  horizontal overflow. A diff block scrolls horizontally inside its own
  box, not the page.
- Accessibility: status badges carry a text label, not only a colour.
- Do not touch the timeline logic, the socket client, the permission card,
  the policies screen or the help panel. They are done and tested.
- `apps/server` is being edited right now. **Never touch it.**
- Do not commit or push.

## Acceptance criteria

- [ ] A pull request renders with its diff, files, state and author.
- [ ] Reviews render as rows with a coloured, labelled state badge.
- [ ] Review comments render with the file, line and resolved state.
- [ ] A pushed commit renders with its diff.
- [ ] CI runs render with a status badge, and a failure shows the job,
      the step and the log.
- [ ] Commits render compactly.
- [ ] Dark and light both look right; 390px has no horizontal overflow.
- [ ] `npm test --workspace @adh/web` passes (55 + new), typecheck and
      lint are clean, and the build succeeds.
- [ ] No absolute URL, port or `VITE_*` in the source or the bundle.

## Verification

```bash
npm run typecheck --workspace @adh/web
npm run lint --workspace @adh/web
npm run build --workspace @adh/web
npm test --workspace @adh/web
```

The new tools do not exist on the server yet. Build the cards against the
**shape** the BACKEND task specifies (it is in
`AGENTS/BACKEND/TASK.md` — read it), and drive them with a **local mock**
outside the repo, under `/tmp/opencode/`, so the work is reviewable.
Say clearly in `SUMMARY.md` what you verified against the mock and what
you could not.

**If you are short of time:** do R1 and R3 (the pull request and the CI
runs) — they are the two the demo turns on — and leave R2 and R4 to the
generic card, which already renders them legibly.
