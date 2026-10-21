# Independent verification — full submission, pre-deadline

> **Before starting:** read `AGENTS/TESTER.md` (scope, report format,
> severity rules), then this task. This is a **read-only** verification:
> report, do not fix.

**Verdict target:** the tree a judge will receive.
**Assigned by:** coordinator
**Date:** 2026-10-21

## Context

Muca is submitted to the Amazon Developer Hackathon 2026 (Alexa+ track,
Option A: self-hosted MCP server). Deadline **2026-10-23**. Two agents have
landed work; the coordinator has reviewed and committed it. Your job is to
find what a hostile, technical judge would find.

Read `AGENTS/BACKEND/summaries/` and `AGENTS/FRONTEND/summaries/` for what
changed and why, then verify the claims against the code and the running
system. **Do not trust the summaries.**

## Scope

Everything below. If something fails, report it with a severity; do not
fix it.

### A. Protocol compliance (highest priority)

Judges penalise a "basic MCP wrapper" and expect evidence the protocol is
genuinely used.

1. Connect a real MCP client over Streamable HTTP to
   `http://localhost:8099/api/v1/mcp`.
2. Assert on the wire:
   - `initialize` negotiates protocol **`2025-11-25`**;
   - `serverInfo` is `muca-mcp` and a version;
   - capabilities include `tools` and `tasks`;
   - `tools/list` returns every tool, with `annotations.destructiveHint`
     and `readOnlyHint` set correctly on the destructive and read-only
     tools.
3. `tools/call` a read-only tool and confirm a well-formed result.
4. **Tasks:** call `diagnose_incident`, confirm it returns a task handle,
   then poll `tasks/get` and confirm the status reaches a terminal state
   with a result. Confirm the tool is advertised as task-backed.
5. **Elicitation:** with a client that declares the elicitation
   capability, call a destructive tool and confirm the server asks the
   client and runs the tool only on approval. With a client that does
   **not** declare it, confirm the tool is refused and nothing changes.
6. Malformed input: unknown tool name, wrong argument type, missing
   required argument. The server must return a clean JSON-RPC error, not
   crash or leak a stack trace.

### B. Approval safety (the headline claim)

The coordinator fixed a P1 in this area; verify the fix holds and look for
what the fix might still miss.

1. Web path: request a destructive action, get a parked `pendingCall`.
   Approve it. Confirm the tool runs.
2. **Approve action A, then get the server to run action B** (same tool,
   different arguments). It must **park again**, not run.
3. Send a **fabricated** `approvedCallIds` entry (an id the server never
   issued). It must not authorise anything.
4. Replay the same approval twice. It must authorise **one** call only.
5. Confirm a non-destructive tool never asks for approval.
6. Try to reach a destructive tool without going through the gate (for
   example a direct `tools/call` over MCP with no elicitation capability,
   or a REST route that bypasses the agent loop). If any path runs a
   destructive tool without an approval, that is **P0**.

### C. Single port

1. Start with `npm run dev` from the workspace root. Everything must be
   served from **`PORT=8099`**: `/` (Next.js), `/api/v1`, `/api/v1/mcp`.
2. Confirm no second port is opened and the browser makes no request to any
   origin other than the page's own.
3. Confirm the built client bundle contains no hardcoded port and no
   `localhost` request target.

### D. Fresh-clone install (high risk, often skipped)

A judge will clone and run this from scratch. In a temp directory, clone or
copy the repo **without** `node_modules`, `.next`, `.env`, and run:

```bash
npm install
npm test
npm run typecheck
npm run build
```

Report anything that only works because of leftover state on this machine
(the workspace pins `zod` via an override and hoists `next` — that is
exactly the kind of thing that breaks on a clean install). Also confirm the
app starts with **no** `.env` at all.

### E. Configuration and secrets

1. `git log --all -- .env` and `git grep` for `sk-`, AWS keys, and tokens.
   No real secret may be in history.
2. `.env` is ignored; `.env.example` is committed and lists every variable
   the code reads. Cross-check `src/config.ts` against `.env.example`.
3. Confirm no hardcoded credentials, hostnames or ports in source.

### F. Frontend

1. With no API key: the demo mode completes end to end and is clearly
   labelled as scripted. The MCP panel still shows a **real** session.
2. With an API provider configured: the timeline shows tool calls,
   evidence and an approval step; approving runs the tool.
3. The MCP panel shows the live session id, the negotiated protocol and
   the JSON-RPC traffic.
4. Keyboard-only: reach and operate the composer and the approval buttons.
5. Responsive at 390px: no horizontal overflow. Light and dark.
6. Check the earlier known cosmetic issue: after a cancelled attempt, does
   the timeline show a stale `DECLINED` row next to a fresh `WAITING` row
   for the same tool? Report severity and reproduction steps if so.

### G. AI provider gateway

1. With **no** keys at all and `AI_PROVIDER=auto`: the server boots, `/health`
   reports `enabled: false` with every provider `not_configured`, and the
   demo mode still runs. A missing model must never stop the server.
2. Point the endpoints at local stubs (`/tmp/opencode/`, not in the repo)
   and verify the selection:
   - Anthropic 200 + OpenAI 200 ⇒ **anthropic**;
   - Anthropic 401 + OpenAI 200 ⇒ **openai**;
   - OpenAI 401 + Gemini 200 ⇒ **gemini**;
   - all fail ⇒ `enabled: false`, not a silent Gemini selection.
3. A **429** must count as usable (the key is valid, it is throttled); a
   **401** must not.
4. **Parallelism:** with three stubs that each delay 800ms and a
   `AI_PROBE_TIMEOUT_MS` of 4000, startup must take roughly 800ms, not
   2400ms. Measure it.
5. **Timeout:** a stub that never answers must be classified `timeout` and
   must not delay the other two.
6. Keys must never appear in a log line, an error message or `/health`, and
   must never be in a URL query string.
7. `POST /api/v1/ai/probe` re-runs the probes and reports `applied: false`;
   the provider in use does not change.
8. Gemini tool calls: two calls to the **same** tool in one turn must both
   resolve back to their own results. This is the id-synthesis trap — if it
   is wrong, the second result returns the first result's data.

### H. Regression suite

Run and record exact output:

```bash
npm test --workspace @muca/server
npm run typecheck
npm run lint
npm run build --workspace @adh/web
```

## Rules

- **Read-only.** Do not edit `apps/**`, `.env`, or config. Do not fix
  anything, even trivially.
- Do not write `AGENTS/BACKEND/` or `AGENTS/FRONTEND/`.
- Do not commit or push.
- If you need a stub model server to drive the agent loop (the sandbox
  cannot reach OpenAI), you may create it **outside the repo**, under
  `/tmp/opencode/`. Say so in the report; it is not part of the submission.
- Every finding needs: severity (P0/P1/P2/P3), what you did, what you
  expected, what happened, and the exact command or URL.

## Deliverables

1. Full report: `AGENTS/TEST_REPORTS/2026-10-21-full-submission.md`, in the
   format `AGENTS/TESTER.md` §6 defines.
2. Short verdict: `AGENTS/TESTER/SUMMARY.md`, with the top findings and a
   pointer to the report.
3. Rename `AGENTS/TESTER/TASK.md` → `AGENTS/TESTER/TASK-COMPLETE.md`.

## Known issues — do not re-report as new

These are already known and accepted. Confirm them only if they are worse
than described, and say so explicitly:

- `GET /api/v1/tools` and `/health` reported 9 tools while MCP reported 10.
  The BACKEND task in flight aligns them; verify at the time you test and
  report the actual state.
- The AI gateway (section G) is **new** and is being written by the same
  BACKEND task. Test the tree as it stands when you start; if it is not
  present, say so rather than inventing results.
- The `DECLINED`-next-to-`WAITING` cosmetic issue in §F6.
- `next dev` may fail on `next/font/google` in a sandbox without network.
  The production build is the supported path; note it if it fails, but it
  is not a submission blocker.
