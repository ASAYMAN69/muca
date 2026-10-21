# Muca Web — App Agent Instructions

## 0. Who you are

- You are a **MAIN agent** in your own session, owning `apps/web` only.
- You are **not a subagent**. Do not use `sub-agent/` directories, per-agent
  markers, or cross-session message files.
- The user talks to the **system coordinator** (the HEAD agent). The
  coordinator writes `AGENT/TASK.md`; the user tells you to read it.
- Never edit `apps/server` or the workspace root. If a task needs the other
  app, **stop** and report it in `AGENT/SUMMARY.md`; the coordinator will
  create a counterpart task.

## 1. Session start checklist

1. If this is a fresh session, read `AGENT.md` (this file). Your context
   persists between tasks, so you normally do not need to re-read it.
2. Check `AGENT/TASK.md` and `AGENT/TASK-COMPLETE.md`:
   - If `TASK-COMPLETE.md` exists and `TASK.md` does not, the previous task
     is still marked complete. **Stop** and tell the user the coordinator
     must reset it before you can work.
   - If neither exists, wait for the coordinator.
3. Read `AGENT/TASK.md` and work only that task.
4. Do not infer requirements from the user chat. The task file is the source
   of truth.

## 2. Task completion protocol

1. Implement within the task's scope. Stay inside `apps/web`.
2. Verify (see §5). Record exact commands and results.
3. Overwrite `AGENT/SUMMARY.md` with the task summary (see §4).
4. Rename `AGENT/TASK.md` → `AGENT/TASK-COMPLETE.md`.
5. Tell the user the task is complete and point to `AGENT/SUMMARY.md`.

Do not rename `TASK-COMPLETE.md` back yourself; the coordinator resets it.

## 3. Project context

**Product.** Muca is an AI agent for the Amazon Developer Hackathon 2026
(Alexa+ track, Option A: self-hosted MCP server). It uses MCP tools to do
real work. It has **no Alexa+ integration** — do not claim otherwise.

**Stack.** Next.js 16 (App Router), React 19, TypeScript 5, Tailwind CSS 4,
ESLint 9.

**One process, one port.** This app does **not** run its own server in
production. The Express server in `apps/server` mounts this app
programmatically and serves it at `/`. `PORT=8099`.

**API boundary (hard rule).**
- `lib/api.ts` is the only API client. Every call is a relative
  `/api/v1/...` path.
- The browser only ever talks to its own origin. There is **no** Vite
  proxy, **no** second port, and **no** absolute backend URL.
- `API_BASE` is the literal `'/api/v1'`. Do not make it configurable from
  the client.
- No `VITE_*` secrets. No hardcoded hosts or ports.
- The MCP endpoint lives at `/api/v1/mcp`. The web client does not talk to
  it directly — it goes through `/api/v1/chat`.

**Layout.**

```
app/
├── layout.tsx     # root layout, fonts, metadata
├── page.tsx       # the chat page (client component)
└── globals.css    # tailwind + theme tokens
lib/
└── api.ts         # the ONLY API client
public/
```

**Design conventions.**
- Tailwind utilities only. No CSS modules, no inline style objects, no new
  CSS files unless the task asks.
- The theme follows the system colour scheme: light and dark both work via
  `dark:` variants. Never hardcode a single background.
- Semantic HTML and real buttons. Buttons that trigger an action are
  `<button type="button">` with an `onClick`; only the composer is a
  `<form>`.
- Every async action needs three states: idle, in-flight, error. A failed
  request must show something — never a silent no-op.
- Accessibility: label icon-only controls, keep focus rings, respect
  `prefers-reduced-motion`.

**Data contract (from `apps/server/src/http/api.ts`).**

`GET /api/v1/health` →

```ts
{
  status: string;
  server: { name: string; version: string };
  mcp: { protocolVersion: string; url: string };
  ai: { enabled: boolean; provider: string | null };
  tools: { name: string; title: string; description: string; destructive: boolean }[];
}
```

`POST /api/v1/chat` body →

```ts
{ message: string; history: { role: 'user' | 'assistant'; content: string }[]; approvedCallIds: string[] }
```

`POST /api/v1/chat` response →

```ts
{
  text: string;
  awaitingConfirmation: boolean;
  pendingCall: { callId: string; name: string; arguments: Record<string, unknown>; message: string } | null;
  events: (
    | { type: 'text'; text: string }
    | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
    | { type: 'tool_result'; id: string; name: string; summary: string; data: unknown }
    | { type: 'confirmation_required'; id: string; name: string; arguments: Record<string, unknown>; message: string }
    | { type: 'error'; message: string }
  )[];
}
```

**Confirmation flow.** When `pendingCall` is non-null, the UI must show an
explicit Approve / Cancel prompt. Approving re-sends the request with the
`pendingCall.callId` in `approvedCallIds`. Cancelling must **not** send
anything.

**Errors.** `apps/server` returns `403`/`400`/`503` with `{ error, details? }`.
Show a generic, human message. Never render a raw stack. The API key is
never in the browser — the server holds it.

## 4. Summary format

```markdown
# Summary — <task title>
**Status:** complete | blocked | partial
**Date:** YYYY-MM-DD

## What changed
- file → what/why

## Verification
- command → result (pass/fail, key output)

## Decisions / trade-offs
- ...

## Follow-ups / risks
- ...
```

## 5. Verification

From the workspace root `/mnt/ee/aprojects/zyrun/adh`:

```bash
npm run typecheck --workspace @adh/web
npm run lint --workspace @adh/web
```

A production build (`npm run build --workspace @adh/web`) is only needed when
the task explicitly says so.

To see it running, start the **server** app — not a Next dev server:

```bash
npm run dev --workspace @muca/server   # serves the frontend at :8099
```

Starting `next dev` directly will fail with "Another next dev server is
already running", because the Express server already owns the Next instance.

## 6. Conventions

- `'use client'` only where interactivity is needed. Keep the page's
  data-fetching on the server where possible.
- No new dependencies without the task explicitly asking. The current
  dependency set is deliberately minimal.
- Components live in `app/` next to the route that uses them, unless a
  component is genuinely shared. This project is small; do not build a
  component library for it.
- The types in `lib/api.ts` are the contract. If the server's response
  shape changes, update them in the same task.
