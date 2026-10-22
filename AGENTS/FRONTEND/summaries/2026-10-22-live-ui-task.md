# The live agent UI: session sidebar, streaming timeline, inline permission, policies, and help

> **Before starting:** if this is a fresh session, read `apps/web/AGENT.md`,
> then `AGENTS/FRONTEND/README.md`, then **`AGENTS/WS_PROTOCOL.md`** in full,
> then this task. The protocol file is the contract; do not deviate from it.
> The task is self-contained; do not infer from the user chat.

**App:** web
**Assigned by:** coordinator
**Date:** 2026-10-22
**Deadline:** tonight

## Status

The judge-facing product is committed and accepted: the timeline, the
artifact cards, the MCP session panel, the demo mode, the approval card,
and 26 tests. **Do not redesign those from scratch — build on them.**

This task turns that into a real product: a **session sidebar**, a
**live streaming** timeline, a **beautiful inline permission card** driven
by a **policy engine**, a **settings screen for policies**, and a **help**
affordance so a first-time user can work out what every control does.

**Read `AGENTS/WS_PROTOCOL.md` first.** The BACKEND agent is building
against it in parallel. Your socket client must match it exactly, or
nothing will connect.

## Load the design skills

You have 49 skills. **Read these before you write a line of UI** — they
are the house style, not decoration:

- `impeccable` — the design pass. Read it first and follow it.
- `frontend-design` — how to build the thing.
- `apple-design` — motion, depth, materials, typography.
- `emil-design-eng` — the invisible details that make software feel good.
- `web-design-guidelines` — the checklist to run before you call it done.

Use the `skill` tool to load them. Do not skip this and do not invent a
style of your own.

## The brief, in plain terms

The user is looking at a page and does not know what the buttons do, and
they said so. Everything must be **obvious without instruction, and
explainable with one click**.

- **Nothing is a mystery.** Every control says what it does. Every icon
  has a name. Where a control is not obvious, it says so.
- **There is a HELP somewhere in the frontend.** A drawer or panel that
  explains the app, every control, and every tool. It must be reachable
  in one click from anywhere, and it must be good enough that someone
  could learn the app from it alone.
- **Dark by default.** The app supports both; dark is the default and
  should look deliberate, not inverted.

## R1 — the session sidebar

**Sessions must be navigable.** A left sidebar, always visible on desktop,
a sheet on mobile.

- Lists the sessions from `GET /api/v1/sessions`, newest first.
- Each row: the title, the relative time, a waiting/active indicator.
- **Click to switch.** Switching closes the old socket and opens a new one
  for that session, and the timeline shows that session's history.
- A **new session** button at the top.
- The title is generated from the first message (the server may generate
  it; if not, derive it client-side from the first user message and
  `PATCH` it).
- A session with a parked permission or a waiting question shows a
  visible marker, so it is obvious where the agent needs you.

## R2 — the socket client

Implement `lib/live.ts` against `AGENTS/WS_PROTOCOL.md` §1–§5.

- Connect to `/api/v1/ws?session=<id>&lastSeq=<n>` — **relative path
  only**, no absolute URL, no hardcoded host or port.
- Track `lastSeq`. On any gap, send `resume` and re-sync.
- **Reconnect with backoff** and re-request from `lastSeq`. A dropped
  connection must never lose a frame.
- Expose a small event API to the app: `on('thinking_delta' | 'message_delta'
  | 'tool_call_started' | 'tool_call_completed' | 'permission_requested' |
  | 'clarification_requested' | 'run_finished' | 'run_error' | 'gap', cb)`.
- **Fall back to REST** when the socket cannot be opened at all, so the
  app still works (the old `POST /api/v1/chat` path is still there).
  The UI must show which mode it is in.
- **The old flow stays working.** `POST /api/v1/chat` and its
  `approvedCallIds` contract are unchanged, and the app must still work
  against them while the socket is being rolled out. Ship the socket
  behind a flag if you need to, but the app must never be broken.

## R3 — the streaming timeline

This is the centre of the product. It must make the agent's work
**watchable**.

- `thinking_delta` → a live "thinking" row. It should feel alive (a
  subtle pulse) and collapse to a summary when the turn ends. Respect
  `prefers-reduced-motion`.
- `message_delta` → the answer types in.
- `tool_call_started` → the tool row appears **immediately**, with the
  arguments it was called with, in a running state.
- `tool_call_completed` → the same row resolves to ok/failed and the
  evidence appears (the existing artifact cards — reuse them).
- The existing `lib/timeline.ts` logic (the fold of a call into its
  approval row, the second-pass status decision) is **good** — keep it,
  and extend it for the new event types rather than rewriting it.
- The existing tests in `apps/web/tests/` must keep passing.

## R4 — the permission card (inline, not a modal)

The user chose **inline**. Build a card that appears in the timeline
where the decision actually happened.

It must be beautiful, and it must be **legible without instruction**:

- The tool's **title and description** (from the tool definition — never
  from the model's prose).
- The **exact arguments** that will run, formatted per argument.
- **What will change** — a plain-English consequence line, derived from
  the tool, e.g. "This creates a branch in the checkout-api repository."
- The **reason it is asking**: the policy that matched, or "no policy
  matched and this tool writes".
- Three actions: **Allow once**, **Deny**, and **Allow and remember**.
  The third creates a policy — say what it will remember, in words, on
  the button or under it.
- Keyboard operable, focus-managed, and announced to screen readers. An
  `aria-live` region for the "agent needs permission" state.
- Denying is a first-class outcome, not an error: explain what would
  have happened instead, and let the agent continue.

## R5 — the policies screen

A settings view, reachable from the sidebar.

- Lists policies: tool, matchers, effect, enabled/disabled, scope
  (global or this session), and a human label.
- **Toggle enable/disable** on each.
- **Create a policy**: pick a tool, add optional argument matchers
  (`equals`, `startsWith`, `contains`, `matches`, `in`), pick an effect
  (allow / ask / deny), give it a label, save.
- Edit and delete.
- Show the **default** clearly: "tools that write are asked about;
  read-only tools are allowed" — with a link to change that per tool.
- A **preview**: "if you allow this, `create_branch` will run without
  asking". Plain language, not JSON.
- The API is `AGENTS/WS_PROTOCOL.md` §11. It may not exist yet when you
  start — build against the contract, and if the endpoint is not there
  yet, show a clear "not available yet" state rather than breaking.

## R6 — help

A help panel, reachable in one click from anywhere (a button in the
sidebar footer, and a `?` in the header).

It must cover:

- **What Muca is** in two sentences, and what it can and cannot do.
- **Every control** in the app: what it does, what happens when you use
  it. Screenshots or small diagrams beat prose.
- **Every tool** the agent can use, with its description and whether it
  writes. The tool list comes from `GET /api/v1/tools`, which already
  exists — do not hardcode it.
- **What the approval system does**, and how policies change it.
- **What to do when it asks you something** — the detached-prompt flow.

It should be a proper document, not a tooltip. Link to it from anywhere
a thing is unclear.

## R7 — the MCP evidence panel

It stays, because it is the proof that MCP is really used. But it is
**collapsed by default** into a status pill in the header (connected ·
protocol · tools · session id). It expands on demand into the current
panel.

It is evidence, not the product. It should not dominate the page.

## R8 — the demo mode

Keep it. It is the safety net when there is no key or the quota is
spent, and it is clearly labelled as scripted.

It must work with the new layout, and it must be obvious it is not a
live run.

## Rules

- **Stay inside `apps/web`.** The BACKEND agent is editing `apps/server`
  right now. Never touch it, and never touch `AGENTS/BACKEND/`.
- **Do not change `AGENTS/WS_PROTOCOL.md`.** If it is wrong, say so in
  `SUMMARY.md` and build the closest thing, and flag it loudly.
- **Do not break the existing tests.** All 26 must still pass. Extend
  them; do not weaken them.
- **Do not commit or push.**
- **The browser only calls relative `/api/v1` paths.** No absolute URLs,
  no hardcoded host or port, in the source or in the built bundle. No
  `VITE_*` variables.
- Tailwind utilities only. No new CSS files.
- Accessibility is a requirement, not a nice-to-have: heading order,
  focus management, `aria-expanded` on every disclosure, `aria-live` for
  the streaming region, full keyboard operation, and `prefers-reduced-motion`
  respected.
- Light and dark both supported; **dark is the default**.
- Responsive: the sidebar becomes a sheet below 768px, the timeline
  stays readable at 390px with no horizontal overflow.

## Acceptance criteria

- [ ] A sidebar lists sessions; clicking one switches the whole view to
      that session, and a new-session button works.
- [ ] The app connects to `/api/v1/ws` and renders a live run: thinking
      appears as it streams, the tool row appears before the tool
      finishes, and the evidence lands when it does.
- [ ] A dropped connection reconnects and **no frame is lost** — the
      timeline after a reconnect is identical to one with no drop.
- [ ] A permission request renders as **one inline card** in the
      timeline, with the tool's description, the exact arguments, the
      consequence, the reason, and Allow / Deny / Allow-and-remember.
- [ ] Denying is graceful and the agent continues.
- [ ] The policies screen can list, create, edit, enable, disable and
      delete policies, and explains the default in plain language.
- [ ] The help panel explains every control and every tool, and is one
      click away.
- [ ] The MCP panel is collapsed by default and expands on demand.
- [ ] Demo mode works in the new layout and is clearly labelled.
- [ ] Dark is the default; light still works.
- [ ] 390px: no horizontal overflow. Keyboard-only: everything works.
- [ ] `npm test --workspace @adh/web` passes, `npm run typecheck
      --workspace @adh/web` and `npm run lint --workspace @adh/web` are
      clean, and `npm run build --workspace @adh/web` succeeds.
- [ ] No absolute URL, hardcoded port or `VITE_*` in the source or the
      built bundle.

## Verification

```bash
npm run typecheck --workspace @adh/web
npm run lint --workspace @adh/web
npm run build --workspace @adh/web
npm test --workspace @adh/web
```

Then **look at it**. Drive it in a headless browser against the real
server on a port of your own (**not 8099** — the coordinator is using
it) and take screenshots of:

- the empty state with the sidebar,
- a live run mid-stream (thinking visible, a tool row running),
- a permission card (the whole card in one frame),
- the policies screen,
- the help panel,
- 390px, and the dark default.

Put the screenshots in `apps/web/screenshots/` and reference them in
`SUMMARY.md`.

**If the socket is not up yet** (the BACKEND agent is building it), build
against the contract, drive the UI with a **local mock socket** so the
work is real and reviewable, and say clearly in `SUMMARY.md` what was
verified against the mock and what was not.

## Out of scope

- The server.
- The MCP endpoint.
- Anything not in `AGENTS/WS_PROTOCOL.md` or this brief.
- A theme switcher, a command palette, a settings page for anything
  other than policies. Those are not asked for and there is no time.
