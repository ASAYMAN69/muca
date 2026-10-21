# Summary — judge-facing product

**Task:** `AGENT/TASK.md` (timeline, artifacts, visible MCP handshake, demo mode)
**App:** web
**Status:** complete
**Date:** 2026-10-21

## What shipped

### R1 — Visible MCP handshake (Option A)

The browser is a real MCP client. `lib/mcp.ts` uses the official
`@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`
against the same-origin `/api/v1/mcp` endpoint. No proxy route, no mock.

The panel (`app/components/mcp-panel.tsx`) is a sticky side panel on desktop
and a collapsible section on mobile. It shows:

- connection status (`idle` / `connecting` / `connected` / `failed`),
- the negotiated protocol version,
- the server identity (`muca-mcp v0.2.0`),
- the full session id, truncated, with a copy button,
- the discovered tool list with name, title, description and `destructive` /
  `read-only` badges,
- the raw JSON-RPC traffic with timestamps — `initialize`, the full
  `tools/list` response, and every `tools/call` the page makes. The log is
  capped at 200 entries and scrolls.

**Why Option A:** verified before committing to it. The SDK transport only
needs `fetch`, `ReadableStream` and `TextDecoderStream`, and a headless
Chromium run against the real server negotiated a live session id and
discovered the tools. A proxy would have shown the protocol but hidden the
browser-side round trip; the task asks for evidence that MCP is actually
invoked, so the direct client is stronger.

To expose the wire traffic without patching the SDK, `lib/mcp.ts` wraps
`transport.send` and `transport.onmessage` and records the raw JSON-RPC.

> Note: `AGENT.md` says the web client does not talk to MCP directly. This
> task explicitly selected Option A, so that line is now stale for the MCP
> panel only; the agent loop still goes through `POST /api/v1/chat`.

### R2 — Timeline

`lib/timeline.ts` turns `events` into ordered steps: tool call (with
formatted arguments), evidence (with raw result expandable), approval,
error. `app/components/timeline.tsx` renders the request and the outcome as
the loud parts, the mechanics as the quiet spine, and `lib/markdown.tsx`
renders the outcome's `**bold**`, `` `code` `` and `- ` lists.

The outcome is suppressed while a run is parked on an approval, because the
assistant's text at that point is preamble, not the answer.

### R3 — Approval

`pendingCall` upgrades the matching tool-call row into an approval step
instead of adding a duplicate row. The prompt states what will happen, the
exact arguments, and that it is consequential, with **Approve & run** and
**Cancel**. Approve re-sends with `approvedCallIds`; Cancel records the
rejection locally in the timeline. Both buttons are ordinary `<button>`s and
work with the keyboard.

After approval the client replaces the run's events with the server's
replayed list, so no step appears twice. The resolved approval row shows
`OK` and keeps its arguments one click away.

### R4 — Artifact cards

`lib/artifacts.ts` builds domain cards from `tool_result.data`:
deployments (collection + one deployment), CI failure (failing job/step,
commit, log tail), branch, pull request, issue (single + list), incident,
plus generic collection/object fallbacks. `artifact-card.tsx` shows title,
status badge, key fields and optional body; the raw payload is behind a
labelled disclosure.

### R5 — Demo mode

`lib/demo.ts` is a self-contained scripted run expressed as the same
`AgentEvent` shape as a live run, so demo and live share one render path.
The demo:

- is labelled `DEMO — SCRIPTED, NOT A LIVE RUN` on the request and with a
  dashed amber outcome card,
- pauses at the destructive step and requires a real approval click,
- runs two approvals (branch, then PR) and finishes with an outcome,
- is available at all times, including when AI is configured.

When `/api/v1/health` reports `ai.enabled: false`, a designed demo banner
explains that only the agent is unavailable (the MCP session, tool catalogue
and JSON-RPC are still real) and offers **Run the demo**. The composer is
disabled with an explanatory placeholder. The duplicated prompt card is
hidden in that state so there is exactly one call to action.

### R6 — Defensive API client

`lib/api.ts` keeps `API_BASE = '/api/v1'`, treats every response field as
optional, and parses events defensively (`parseAgentEvents`) so unknown
events are carried separately instead of breaking the timeline.

- `GET /api/v1/runs` powers **Previous runs** (`run-history.tsx`); if the
  route 404s the panel stays hidden.
- `GET /api/v1/tasks/:taskId` is polled while a run reports a task id and
  the status is non-terminal. A 404 stops polling for that task id; it
  never blocks the UI.
- Errors from the API are shown in a dismissible `role="alert"` banner.

### R7 / R8 — Design and accessibility

- Tailwind utilities only; light and dark via `dark:`; no new CSS files.
- Semantic headings: `h1` page, `h2` Request/Timeline, `h3` steps, `h4`
  card titles and "What will happen".
- Every disclosure is `<button aria-expanded aria-controls>`; the two
  expandable regions are labelled by their own controls.
- The running pulse uses `motion-safe:animate-pulse`, so it is disabled by
  `prefers-reduced-motion`.
- Visible focus rings throughout; icon-only controls have accessible names.

## Files

New:

- `app/components/run-history.tsx`

Modified:

- `app/page.tsx` — run/demo state machine, task polling, MCP session tool
  count and destructive-tool union, no-key empty state.
- `app/components/timeline.tsx` — heading levels, resolved approval
  arguments, reduced-motion pulse.
- `app/components/mcp-panel.tsx` — publish session updates outside the
  state updater (see fixed bug below).
- `lib/timeline.ts` — keep an approved call linked to its result so the row
  resolves to `OK`.

Already delivered earlier in this session and committed by the coordinator:
`lib/api.ts`, `lib/mcp.ts`, `lib/artifacts.ts`, `lib/demo.ts`,
`lib/markdown.tsx`, `app/components/artifact-card.tsx`,
`app/components/mcp-panel.tsx`, `app/components/timeline.tsx`,
`app/page.tsx`, `apps/web/package.json`.

## Dependency added

`apps/web/package.json`: `@modelcontextprotocol/sdk@^1.32.1` (R1, Option A).
This is the only new dependency. It is already present in the workspace
because the server uses the same SDK.

## Bug fixed during verification

Publishing the MCP session to the page from inside a `setSession` updater
called the parent's `setState` during render. Production React threw
`Minified React error #185` (maximum update depth) on every traffic
message. The panel now publishes from the client's update callback via
`useCallback`, outside the updater; the headless run reports no page errors.

## Verification

All commands run from `/mnt/ee/aprojects/zyrun/adh`.

```
npm run typecheck --workspace @adh/web   # clean
npm run lint --workspace @adh/web        # clean
npm run build --workspace @adh/web       # compiled successfully
```

Serving: the web app is mounted by the server, so verification used the
single-port production entry point, never `next dev`:

```
cd apps/server && PORT=8111 NODE_ENV=production npx tsx src/index.ts
```

### Real MCP session

Opened `http://localhost:8111/`, waited for the panel, expanded it:

- status `connected`, protocol `2025-11-25`, server `muca-mcp v0.2.0`
- live session id (e.g. `d96c71c0…969e`) with a working copy button
- timestamped JSON-RPC traffic beginning with `initialize` and the full
  `tools/list` result
- `DESTRUCTIVE` badges on `create_branch` and `open_pull_request`
- the badge in the status strip reads `10 tools`, matching the panel

Screenshot: `/tmp/opencode/shots-final/mcp-open.png`

### Live destructive approval, end to end

OpenAI is unreachable from this sandbox, so a minimal
OpenAI-compatible mock (`/tmp/opencode/mock-openai.mjs`, not part of the
app) ran on `:8199`; the real Muca server ran on `:8113` with
`OPENAI_BASE_URL=http://localhost:8199/v1`.

Typing "Create a branch fix/verify-approval from main" produced a blocked
approval step. Clicking **Approve & run** re-sent the request; the server
executed `create_branch` over MCP and the timeline resolved to:

```
Create Branch · create_branch · DESTRUCTIVE · OK
  Show arguments (2)
Create Branch result · create_branch · OK
  Branch fix/verify-approval / from main / HEAD f10c2de
OUTCOME  The branch fix/verify-approval was created from main.
```

Screenshots: `/tmp/opencode/shots-final/live-1-approval.png`,
`/tmp/opencode/shots-final/live-2-approved.png`

### Demo mode

- AI configured: the demo link runs the scripted flow through both
  approvals to the PR outcome. Screenshot:
  `/tmp/opencode/shots-final/demo-final.png`
- No key (`PORT=8112 OPENAI_API_KEY= npx tsx src/index.ts`): banner reads
  "The AI provider is not configured", `/health` says `ai.enabled: false`,
  the composer is disabled, and **Run the demo** completes the same flow at
  390px with no overflow. Screenshots:
  `/tmp/opencode/shots-final/nokey.png`,
  `/tmp/opencode/shots-final/nokey-demo-390.png`

### Accessibility probe (headless Chromium)

- Composer reachable by Tab and submitted with Enter.
- Approval focused with Tab and triggered with Enter.
- All `aria-expanded` disclosures report their state.
- No unnamed buttons.
- Heading order: `H1 Muca` → `H2 Request` → `H2 Timeline` → `H3` steps →
  `H4` cards / "What will happen".
- No page errors.

### Responsive and colour schemes

390×844 light, 390×844 dark, 1440×1000 dark: `scrollWidth === clientWidth`
in every case, no overflowing elements. Screenshots:
`/tmp/opencode/shots-final/m390-light.png`,
`/tmp/opencode/shots-final/m390-dark.png`,
`/tmp/opencode/shots-final/d1440-dark.png`

### Client bundle inspection

```
grep -rhoE "https?://(localhost|127\.0\.0\.1|…:[0-9]+)" apps/web/.next/static
grep -roE ":(8099|8100|8111|8112|8113|8199)\b"      apps/web/.next/static
grep -rl  "VITE_"                                    apps/web/.next/static
```

No absolute URLs, no hardcoded ports, no `VITE_*` variables. The single
`localhost` occurrence is a host-comparison string inside the bundled
SDK/undici URL parser, not a request target. All app requests go to the
relative `/api/v1`.

## Known environment caveats

- `next dev` (port 8099) intermittently fails here on `next/font/google`
  because the sandbox cannot reach `fonts.googleapis.com`. The production
  build resolves the fonts and works; verification used the production
  entry point.
- The real OpenAI API is unreachable from this sandbox, hence the local
  mock for the live-run check. The app path exercised is the real server,
  real agent loop and real MCP transport; only the LLM HTTP endpoint was
  substituted.
- The backend agent is editing `apps/server` in parallel. I did not modify
  `apps/server` or the workspace root.

## Backend note (not blocking)

`MCP tools/list` advertises **10** tools including `diagnose_incident`, but
`GET /api/v1/health` and `GET /api/v1/tools` both return **9** (no
`diagnose_incident`). The web app now unions the `/health` catalogue with
the MCP session's discovery for destructive badges and shows the MCP count
in the status strip, so the UI stays correct either way. It is worth
aligning the two REST catalogues with the registry.

## Not done / out of scope

- No server changes.
- No commit or push (per task).
- No Alexa+ integration claimed anywhere.
