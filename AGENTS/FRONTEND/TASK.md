# Judge-facing product: timeline view, artifacts, visible MCP handshake, demo mode

> **Before starting:** if this is a fresh session, read `AGENT.md` in
> `apps/web`, then read `AGENTS/PLAN.md` at the workspace root. Then read
> this task. The task is self-contained; do not infer from the user chat.

**App:** web
**Assigned by:** coordinator
**Date:** 2026-10-21

## Goal

Turn the chat page into a product a judge can understand in ten seconds: a
**timeline** of what the agent did, **artifact cards** for what it produced, a
**visible MCP handshake** that proves the protocol is really in use, and a
**demo mode** that lets a judge reproduce the whole flow with no API key and
no secrets.

## Why / context

Muca targets the **Alexa+ track** of the Amazon Developer Hackathon 2026
via **Option A: a self-hosted MCP server**. The judging criteria are:
tech implementation, design, potential impact, and quality of idea. Amazon
explicitly labels "a basic MCP wrapper around an existing API" as obvious,
and explicitly requires **clear evidence that MCP is actually invoked at
runtime, not merely mentioned in the README**.

The current page is a working chat box: it shows the assistant's text, the
tool calls and the approval prompt. That is functional but it reads as
"a chatbot", which is precisely the category Amazon calls obvious.

The three changes that matter most for this track:

1. **Make the MCP handshake visible.** Show the session id, the tool list
   the server published, and the raw JSON-RPC exchange. A judge should be
   able to see protocol compliance without opening devtools. This is the
   single highest-value change for this specific track.
2. **Replace the chat transcript with a timeline.** "Check the failing
   deployment, find the cause, open a PR — but ask me first" is a
   *workflow*, not a conversation. Show the steps, the evidence, the
   approval, the outcome.
3. **Demo mode.** A judge with no API key, no GitHub token and no AWS
   credentials must still be able to click through the whole thing.

The BACKEND agent is running in parallel and is adding:
MCP Elicitation, MCP Tasks, a Bedrock provider, an Ops Copilot tool set
(against seeded mock adapters), and session-scoped run history with
`GET /api/v1/runs` and `GET /api/v1/runs/:runId`.

**Build against the current, stable contract.** Do not block on the
backend. The routes and shapes below are what the BACKEND agent has been
told to deliver; if the exact shape differs, build defensively (see R6).

## Scope

**In scope — `apps/web` only:**

- `apps/web/app/**` — pages and components.
- `apps/web/lib/**` — the API client and any types/helpers.
- `apps/web/next.config.ts` — only if a build constraint requires it.
- `apps/web/AGENT/SUMMARY.md`, `AGENT/TASK-COMPLETE.md`.

**Out of scope:**

- `apps/server/**` — the BACKEND agent owns that. If you need a server
  change, define the exact contract in `SUMMARY.md` and the coordinator
  will create a counterpart task.
- The workspace root (`package.json`, `AGENT.md`, `AGENTS/`, `README.md`).
- Adding npm dependencies to the workspace root. If you need a new
  dependency for `apps/web`, add it to `apps/web/package.json` and list it
  in `SUMMARY.md` — but prefer not to.
- Deployment / hosting config.
- The `zod` or MCP SDK versions.

## Requirements

### R1 — Visible MCP handshake panel

Add a panel (a side panel on desktop, a collapsible section on mobile) that
shows the live MCP state. It must prove the protocol is real.

The server exposes the MCP endpoint at `/api/v1/mcp`. The **browser** should
act as a real MCP client. Two options:

- **Option A (recommended):** implement the MCP handshake in the browser
  using a browser-capable MCP client. Verify that the official SDK's client
  works in a browser bundle before committing to it — the SDK's
  `StreamableHTTPClientTransport` uses `fetch` and `EventSource`, so it
  generally works, but **verify it in the actual Next.js build** and
  report what you find.
- **Option B (fallback):** add a small server-side proxy route in
  `apps/web/app/api/mcp-inspect/route.ts` that performs the handshake with
  the SDK's `Client` and returns the session id + tool list to the browser.
  This still proves the protocol, and the browser never talks to MCP
  directly.

Pick one, justify it in `SUMMARY.md`, and implement it properly.

The panel must show:
- **Connection status** — connecting / connected / failed.
- **The negotiated protocol version** (from `GET /api/v1/health`).
- **The server identity** — name and version.
- **The session id** (truncated, with a copy button).
- **The discovered tool list** — each tool's name, title, description, and
  a clear **destructive** badge.
- **The raw JSON-RPC traffic** — a scrolling log of the actual
  `initialize` / `tools/list` / `tools/call` messages, with timestamps.
  This is the single most persuasive artefact for the judges.

Design it so a judge can open it and immediately see "this is a real MCP
server, not a mock".

### R2 — Timeline view, not a chat transcript

Restructure the main view around a **run timeline**.

A run consists of ordered steps. Render:

- **The request** — what the user asked for.
- **Tool call steps** — tool name, the arguments (readable, formatted),
  and a clear pending/running/success/failed state.
- **Evidence steps** — the tool result, summarised, with the raw result
  expandable.
- **Approval steps** — the confirmation prompt (see R3).
- **The outcome** — the final answer, with artifacts (see R4).

The existing `events` array from `POST /api/v1/chat` already carries
`text`, `tool_call`, `tool_result`, `confirmation_required` and `error`.
Build from that. Add an `artifact` event type only if the backend provides
one — otherwise render artifacts from `tool_result.data`.

Keep it legible: the timeline is the primary surface, the raw JSON is
secondary and collapsible.

### R3 — Approval step

When `pendingCall` is non-null, render an explicit **Approve / Cancel**
prompt as part of the timeline. This is the safety story and it should look
deliberate, not like a browser `confirm()`.

- Approve re-sends with the `pendingCall.callId` in `approvedCallIds`.
- Cancel sends nothing and records the rejection locally, shown in the
  timeline.
- The prompt must state **what** will happen, **with what arguments**, and
  that it is consequential.
- Also show a **"what will happen"** line for a tool the agent intends to
  run, before it runs, when the backend provides that signal.

### R4 — Artifact cards

Render structured results as **cards**, not raw JSON. A card shows a title,
the key fields, and a status. Examples for the Ops Copilot tool set:
deployment status, CI failure with the failing step and error, a PR
summary, an issue summary.

Design a small, reusable card component. Cards must be readable at a
glance — a judge should see the outcome without expanding anything.

### R5 — Demo mode

The judge must be able to click through the whole flow **with no API key and
no secrets**.

- When `GET /api/v1/health` reports `ai.enabled === false`, the app must
  **not** look broken. It should show a clear, attractive **demo mode**
  state explaining that the AI provider is not configured and offering a
  way to see the full flow anyway.
- Implement the demo mode against the **seeded mock tools** the BACKEND
  agent is adding. Since the backend is a separate agent and its exact
  routes are not final, implement demo mode as a **self-contained scripted
  run** in the frontend: a canned sequence of timeline steps that shows the
  same thing a real run shows. It must be clearly labelled **"demo"** so
  nobody mistakes it for a live run.
- Do **not** fake a real agent result in a way that could be mistaken for
  genuine output. The demo state must be visibly a demo.

This is a deliberate hedge: the demo must work even if the backend's seeded
mode is not ready.

### R6 — Defensive API client

The backend agent is changing the server **in parallel**. Build the client
to tolerate both the current and the likely new shapes:

- `GET /api/v1/health` — today: `{ status, server, mcp, ai, tools }`. Treat
  every field as optional and degrade gracefully.
- `POST /api/v1/chat` — today: `{ text, awaitingConfirmation, pendingCall,
  events }`. Expect the response to **grow** (artifacts, run ids, task
  ids). Read new fields defensively; never assume a field exists.
- `GET /api/v1/runs`, `GET /api/v1/runs/:runId` — new. Implement them, but
  make the UI work if they 404 or are not yet implemented.
- `GET /api/v1/tasks/:taskId` — new. Poll it if a run reports a task id.
  Do not block on it.

Type them as optional/unknown where the shape is not yet fixed. Do not
crash on a missing field. Do not silently swallow a real error — show it.

### R7 — Visual quality

This is judged on **design**. Hold a high bar.

- Tailwind utilities only; no CSS modules, no inline style objects, no new
  global CSS files unless genuinely needed.
- Light and dark both work, via `dark:` variants. Do not hardcode one
  background.
- A real type scale and consistent spacing. Avoid the generic-AI look:
  no purple-to-blue gradient hero, no floating rounded cards on a grey
  background, no centred "chat bubble" cliché.
- Use the timeline structure to create **visual hierarchy**: the request
  and the outcome are prominent, the mechanics are quiet.
- Micro-interactions: tool steps can animate in as they resolve. Respect
  `prefers-reduced-motion` and keep it tasteful.
- Empty states, loading states and error states must all be designed.
- Accessibility: real buttons, labelled controls, visible focus, sensible
  heading order, sufficient contrast.
- Responsive: the timeline must work on a phone. The MCP panel becomes a
  drawer or a collapsible section.

### R8 — Accessibility and keyboard

- Every interactive element is reachable and operable by keyboard.
- The approve/cancel prompt must be reachable without a mouse.
- Expandable regions use `<button aria-expanded>` and are labelled.

## Constraints

- **Stay inside `apps/web`.** Never edit `apps/server` or the workspace root.
- **Do not commit or push.** The coordinator commits after reviewing your
  summary.
- **One port, one origin.** The browser only ever calls relative `/api/v1`
  paths. No absolute URLs, no `VITE_*` secrets, no host sniffing, no
  hardcoded `localhost:8099`. The API base stays the literal `'/api/v1'` in
  `lib/api.ts`.
- **No `process.env` in client code.** Anything the client needs must come
  from an API response.
- **No new dependencies** unless genuinely necessary — list them in
  `SUMMARY.md` if you add any. The current dependency set is deliberately
  minimal (next, react, react-dom, tailwind).
- **Keep `lib/api.ts` as the only API client.** Add a dedicated MCP client
  module if you implement Option A, but it must still live in `lib/`.
- **Do not claim Alexa+ integration.** Muca has none. If you write copy that
  implies it, remove it.
- **Do not fake results.** Demo mode must be visibly a demo.

## Acceptance criteria

- [ ] `npm run typecheck --workspace @adh/web` is clean.
- [ ] `npm run lint --workspace @adh/web` is clean.
- [ ] `npm run build --workspace @adh/web` succeeds.
- [ ] The MCP handshake panel shows a real, live session: status, protocol
      version, server identity, session id, tool list with destructive
      badges, and the raw JSON-RPC log. Verified against the running
      server, not mocked.
- [ ] The main view is a timeline of steps, not a chat transcript.
- [ ] A destructive tool produces an explicit Approve / Cancel prompt in
      the timeline, and Approve actually runs the tool.
- [ ] Tool results render as readable cards, not raw JSON.
- [ ] With no API key configured, the app shows a designed demo mode that
      demonstrates the full flow and is clearly labelled as a demo.
- [ ] The page works on a 390px-wide viewport with no horizontal scroll and
      no overlapping elements.
- [ ] Light and dark both render correctly.
- [ ] The client bundle contains **no** absolute backend URL, no
      `VITE_*` secret and no hardcoded port. (Verify by inspecting the
      build output — report what you checked.)
- [ ] Keyboard-only operation works for the composer and the approval
      prompt.

## Verification

From `/mnt/ee/aprojects/zyrun/adh`:

```bash
npm run typecheck --workspace @adh/web
npm run lint --workspace @adh/web
npm run build --workspace @adh/web

# live check — start the SERVER app (not `next dev`, it will conflict)
npm run dev --workspace @muca/server
# then open http://localhost:8099
```

For the MCP panel, verify against the **real running server** with a real
MCP handshake. If you use Option A, also confirm the browser bundle
actually works — check the browser console for errors and confirm the
session id appears. A panel that renders a hardcoded tool list does **not**
satisfy this criterion.

For the layout checks, take screenshots at 390px and 1440px in both colour
schemes and include them (or their paths) in `SUMMARY.md`.

## Out of scope

- Backend work (`apps/server`).
- Deployment, hosting, domain, CI/CD.
- The workspace root files.
- Real GitHub / AWS integrations from the browser.
- User accounts, auth UI, settings pages.
- i18n / localisation.
- Animations beyond what the timeline needs.

## Notes

- Read `apps/web/AGENT.md` for the current API contract and the design
  conventions this app already follows.
- The BACKEND agent's `SUMMARY.md` will list the exact new routes. The
  coordinator will relay it to you. Until then, build defensively per R6.
- The current `app/page.tsx` already renders tool calls, tool results and
  the approval prompt. You are **restructuring and elevating** it, not
  starting from zero. Preserve what works.
- `lib/api.ts` already has the response types. Extend them; do not
  duplicate them in components.
- The current page is a single client component. Splitting it into
  components under `app/` (or a `components/` folder) is welcome if it
  improves readability — but do not build a component library.
