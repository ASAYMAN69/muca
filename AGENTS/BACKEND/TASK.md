# Align the REST tool catalogue with what the server actually advertises

> **Before starting:** if this is a fresh session, read `apps/server/AGENT.md`,
> then `AGENTS/BACKEND/README.md`, then this task. The task is
> self-contained; do not infer from the user chat.

**App:** server
**Assigned by:** coordinator
**Date:** 2026-10-21

## Status

Small task. The P1 approval fix and the previous round are committed and
accepted — **do not revisit them**. This is one consistency bug and nothing
else.

## The bug

The server advertises two different tool catalogues:

```
MCP  tools/list        -> 10 tools (includes diagnose_incident)
GET /api/v1/tools      ->  9 tools (no diagnose_incident)
GET /api/v1/health     ->  9 tools (no diagnose_incident)
```

Confirmed live by the coordinator against the running server:

```
tools: ['echo','list_deployments','get_deployment','get_ci_failure',
        'list_issues','create_issue','comment_on_issue','create_branch',
        'open_pull_request']
```

`diagnose_incident` is registered in the MCP layer (`src/mcp/tasks.ts`)
rather than in the `ToolRegistry`, so the router in `src/http/api.ts` that
maps `deps.registry.list()` never sees it.

## Why it matters

Muca's headline claim is that **every** capability is a real MCP tool. A
judge comparing the two endpoints sees the server disagree with itself
about its own surface: the API says 9, the protocol says 10. It also means
the web UI has to union two sources to stay correct, which is a workaround
for a backend inconsistency.

## Goal

One source of truth for the tool surface. `GET /api/v1/tools`,
`GET /api/v1/health` and MCP `tools/list` must all describe the same set.

## Requirements

### R1 — One catalogue

Make the REST catalogue include `diagnose_incident`. Choose the mechanism;
the constraint is that the set is declared **once** and both the router and
the MCP layer derive from it. Do not copy the list into a second place, and
do not special-case the name `diagnose_incident` in `api.ts`.

A reasonable shape is an exported catalogue (e.g. `TOOL_CATALOGUE`) that
carries registry tools plus protocol-level tools, with a marker for
"task-backed". You are free to pick a different shape if it is simpler, but
say why in `SUMMARY.md`.

### R2 — The advertised metadata must be honest

`diagnose_incident` is **not** a plain `tools/call` tool: it returns a task
handle. Whatever the REST response shows for it must not claim it is an
ordinary synchronous tool. Include a field that distinguishes it (for
example `taskBacked: true`), and make sure the existing fields for the
other 9 tools are unchanged.

Keep the change **additive**: existing consumers must not break. The web
client currently reads `tools[].name` and `annotations` — do not rename
those.

### R3 — Tests

- A test asserting `/api/v1/tools` and `/api/v1/health` both report the
  same number of tools as the MCP layer advertises, and that
  `diagnose_incident` is present in both REST responses.
- A test asserting the 9 previously-reported tools are still present with
  unchanged names and annotations.
- If you add a marker field for task-backed tools, a test asserting it is
  set for `diagnose_incident` and not set for a normal tool.

### R4 — Update the web client only if it breaks

The FRONTEND app is not yours. The web client already unions `/health`
with the MCP session, so it should keep working unchanged. **Do not edit
`apps/web`.** If you believe a frontend change is required, stop and
report it instead.

## Constraints

- **Stay inside `apps/server`.**
- **Do not change the approval code.** It is correct and committed.
- **Do not change the tool implementations**, only how the catalogue is
  assembled and reported.
- **Do not commit or push.**
- **Do not weaken existing tests.** All 154 must still pass.
- Zod stays `4.6.7`; MCP SDK stays `1.32.1`.
- No new dependencies.

## Acceptance criteria

- [ ] `GET /api/v1/tools` and `GET /api/v1/health` both report **10**
      tools, matching MCP `tools/list`.
- [ ] The catalogue is declared in exactly one place; `api.ts` contains no
      hardcoded tool name.
- [ ] `diagnose_incident` is clearly marked as task-backed in the REST
      response.
- [ ] The 9 existing entries are unchanged in name and annotations.
- [ ] `npm test --workspace @muca/server` passes (154 pre-existing + new).
- [ ] `npm run typecheck --workspace @muca/server` and
      `npm run lint --workspace @muca/server` are clean.

## Verification

From `/mnt/ee/aprojects/zyrun/adh`:

```bash
npm test --workspace @muca/server
npm run typecheck --workspace @muca/server
npm run lint --workspace @muca/server
```

Then start the server and compare the three surfaces by hand:

```bash
npm run dev --workspace @muca/server
curl -s localhost:8099/api/v1/tools  | python3 -m json.tool | grep -c '"name"'
curl -s localhost:8099/api/v1/health | python3 -m json.tool | grep -c '"name"'
```

and confirm MCP `tools/list` returns the same names (the SDK client probe
in `AGENTS/mcp_protocol.md` does this). Paste the three outputs into
`SUMMARY.md`.

## Out of scope

- The approval/authorisation code.
- New tools.
- The frontend.
- Anything in `AGENTS/FRONTEND/` or `AGENTS/TESTER/`.
