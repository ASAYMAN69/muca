# Protocol-native upgrade: Elicitation, Tasks, Bedrock, and the Ops Copilot tool set

> **Before starting:** if this is a fresh session, read `AGENT.md` in
> `apps/server`, then read `AGENTS/mcp_protocol.md` at the workspace root.
> Then read this task. The task is self-contained; do not infer from the
> user chat.

**App:** server
**Assigned by:** coordinator
**Date:** 2026-10-21

## Goal

Turn the working MCP skeleton into a product-shaped server: replace the
ad-hoc destructive-action gate with **MCP Elicitation**, add **MCP Tasks**
for long-running work, add a second AI provider (**Amazon Bedrock**) behind
the existing `AIProvider` interface, and replace the placeholder tools with
a coherent **Ops Copilot** tool set that a judge can exercise without any
secrets.

## Why / context

Muca targets the **Alexa+ track** of the Amazon Developer Hackathon 2026
via **Option A: a self-hosted MCP server**. The hard requirement is a server
implementing MCP `2025-11-25` over Streamable HTTP. The current skeleton
already satisfies that and is verified working (21 passing tests).

Amazon's judges explicitly label "a basic MCP wrapper around an existing API"
as obvious, and explicitly credit **agentic workflow that orchestrates across
services**, **state maintained across sessions**, and **safety with user
approval**. The Elicitation / Tasks / Sampling features of the MCP protocol
are exactly the primitives that make this submission more than a wrapper —
and the SDK we pinned already contains all of them.

The current state has three gaps that this task closes:

1. **Approval is ad-hoc.** We invented `approvedCallIds` in our own REST
   shape. MCP has a protocol-native mechanism for this: **Elicitation**,
   where the server asks the *client* for structured input.
2. **No long-running work.** Nothing can take 30 seconds. MCP **Tasks**
   exist for exactly this and are in the pinned SDK.
3. **The model is locked to OpenAI.** The `AIProvider` interface was
   designed for this; adding Bedrock is a small, isolated change and
   qualifies for the separate **AWS Builder mini-challenge** prize track.

The tool set is still placeholder. It needs to become a coherent domain.

## Scope

**In scope — `apps/server` only:**

- `apps/server/src/ai/**` — provider abstraction, Bedrock adapter, agent
  loop changes.
- `apps/server/src/mcp/**` — elicitation + tasks wiring, tool registration.
- `apps/server/src/tools/**` — the new Ops Copilot tool set.
- `apps/server/src/http/**` — REST routes needed to drive the new features.
- `apps/server/src/config.ts` — new env vars.
- `apps/server/tests/**` — tests for everything you add.
- `apps/server/package.json` — new dependencies (Bedrock SDK, etc.).
- `apps/server/AGENT/SUMMARY.md`, `AGENT/TASK-COMPLETE.md`.

**Out of scope:**

- `apps/web/**` — the FRONTEND agent owns that. If you need a REST contract
  change, define it precisely in `SUMMARY.md` and the coordinator will
  create a counterpart task.
- The workspace root (`package.json`, `AGENT.md`, `AGENTS/`, `README.md`).
  If you need a root change, report it in `SUMMARY.md`.
- Deployment / IaC / AWS resources. Not this task.
- The zod version. **Do not touch zod.** It is unified at `4.6.7` via a root
  `overrides` entry. Changing it breaks the SDK at runtime — see
  `AGENTS/mcp_protocol.md`.
- The MCP SDK version. Do not bump it. If you believe you must, stop and
  report it.

## Requirements

### R1 — `ApprovalGate` abstraction + MCP Elicitation

Create `apps/server/src/ai/approval-gate.ts` (or an equivalent module) with a
single interface that both transports use:

```ts
export interface ApprovalRequest {
  toolName: string;
  title: string;
  message: string;
  arguments: Record<string, unknown>;
}

export interface ApprovalGate {
  request(input: {
    approval: ApprovalRequest;
    /** Unique id for this request; used to correlate the approval. */
    requestId: string;
    /** When the client cannot elicit (plain HTTP), fall back to this. */
    fallback: () => Promise<boolean>;
  }): Promise<boolean>;
}
```

Two implementations:

1. **Elicitation implementation** — uses
   `server.elicitInput(...)` from the MCP SDK
   (`ElicitRequestFormParams` / `ElicitRequestURLParams`). The server asks
   the *client*; the client answers with a structured result. This is the
   protocol-native path and must work for any MCP client.
2. **HTTP fallback** — the current `approvedCallIds` mechanism, behind the
   same interface, for the plain-web-client path.

The agent loop must call the `ApprovalGate` before running any tool
registered with `destructive: true`. It must not know which implementation
is in use.

**Key constraint:** the MCP server instance is created per-session inside
`McpHttpHandler.handlePost`. The elicitation implementation needs a handle
on that server. Restructure so the `ApprovalGate` can reach the current
session's server, **without** introducing a global singleton that leaks
sessions across users. If you cannot do this cleanly, implement the
fallback-first design and report the limitation in `SUMMARY.md` rather
than shipping something leaky.

### R2 — MCP Tasks for long-running work

Add at least **one** genuinely long-running tool backed by MCP Tasks
(`@modelcontextprotocol/sdk/experimental/tasks/*` — read
`node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/` to
learn the exact API; do not guess).

Requirements:
- The tool returns a task handle quickly instead of blocking.
- Task status is observable: `queued`, `running`, `awaiting_input`,
  `completed`, `failed` (use the SDK's own status vocabulary — read it).
- A REST route exposes task status so the frontend can poll it
  (`GET /api/v1/tasks/:taskId`). The exact path is yours to choose, but
  report it precisely in `SUMMARY.md`.
- The task actually does work over multiple ticks, and the work is
  cancellable or times out. It must not leak a runaway timer.

Read the SDK's task types before writing code. The API is experimental and
its shape is not obvious.

### R3 — Bedrock provider behind `AIProvider`

Add `apps/server/src/ai/bedrock-provider.ts` implementing the existing
`AIProvider` interface (`apps/server/src/ai/provider.ts`).

- Use the official AWS SDK for JavaScript v3 (`@aws-sdk/client-bedrock-runtime`).
- Use the **Converse API** (`ConverseCommand` / `ConverseStreamCommand`).
  It is the current Bedrock API and maps cleanly onto the neutral
  `ProviderMessage` shape.
- Must support **tool use** — Bedrock's `toolConfig` / `toolUse` blocks must
  map to `ProviderToolCall` and back, exactly like the OpenAI adapter.
- Model id comes from env (`BEDROCK_MODEL_ID`), not hardcoded.
- Region comes from env (`AWS_REGION`).
- Credentials come from the standard AWS credential chain. **Never** hardcode
  or read a static key from `.env`.
- Selecting the provider is env-driven, e.g. `AI_PROVIDER=openai|bedrock`.
  Default stays `openai` so local dev and the current tests keep working.

**Do not** change the `AIProvider` interface. If you think it needs to
change, stop and report it — the FRONTEND agent and the tests depend on
the current shape.

### R4 — The Ops Copilot tool set

Replace the placeholder tools in `apps/server/src/tools/index.ts` with a
coherent domain. Target: **deployment / CI failure triage for solo
developers and small teams.**

Proposed set (refine if you find better, but keep it coherent and small):

| Tool | Destructive | Purpose |
|---|---|---|
| `list_deployments` | no | Recent deployments for a service, with status |
| `get_deployment` | no | One deployment, with logs/metadata |
| `get_ci_failure` | no | The failing CI run: which job, which step, the error |
| `list_issues` | no | Open issues/tickets, filterable by state |
| `create_issue` | no | Open a new issue/ticket |
| `create_branch` | **yes** | Create a branch — consequential |
| `open_pull_request` | **yes** | Open a PR — consequential |
| `comment_on_issue` | no | Add a comment |

Requirements:
- **No external service credentials.** Implement a deterministic **seeded
  mock adapter** so a judge can run the whole flow with zero secrets. The
  mock must be deterministic (same input → same output) so the demo is
  reproducible.
- Structure it so a real adapter can be swapped in later (a thin interface
  per service). Do not build a plugin system.
- Keep the Zod schema + `destructive` flag pattern from the current code.
- Remove the placeholder `echo` / note tools, or keep `echo` **only** if
  you justify it as a connectivity check. Justify it in `SUMMARY.md`.

### R5 — State across sessions

Amazon explicitly credits "state maintained across sessions". Implement
**session-scoped run history** so a client can see what happened in a
previous run.

- Persist at least: run id, timestamp, the tool calls made, the approval
  decisions, and the final outcome.
- A **file-backed** store is acceptable and preferred over DynamoDB here
  (no AWS resources in this task, and it must work locally with no setup).
  Put it outside `apps/server/src` if you prefer — but keep it gitignored.
- Expose `GET /api/v1/runs` and `GET /api/v1/runs/:runId`. Report the exact
  shapes in `SUMMARY.md`.
- The history must survive a server restart.

### R6 — REST contract

Add whatever routes the above need, under `/api/v1`. Keep the existing
`/api/v1/health`, `/api/v1/tools`, `/api/v1/chat` working and keep their
response shapes **backwards compatible** — the FRONTEND agent depends on
them. If you must extend a response, only **add** fields.

Document every new route in `SUMMARY.md` with: method, path, request body,
response body. The FRONTEND agent needs this to build against.

### R7 — Configuration

New env vars go in `apps/server/src/config.ts` and are documented in
`SUMMARY.md`. The coordinator will update the root `.env.example` — do not
edit the root file yourself. List the exact env var names, defaults, and
whether they are required.

### R8 — Tests

Extend `apps/server/tests/`:

- The existing 21 tests must still pass **unchanged**. If a test needs to
  change, that is a red flag — justify it in `SUMMARY.md`.
- New tests for:
  - the `ApprovalGate`: both implementations, and that a destructive tool
    is **not** executed without approval.
  - the task-backed tool: returns a handle fast, status progresses, and it
    terminates.
  - the Bedrock adapter: unit-test the **message/tool-use mapping** against
    a stubbed `BedrockRuntimeClient`. Do not make real AWS calls in tests.
  - each new tool: happy path, validation failure, and (for destructive
    ones) that it is flagged.
  - the run-history store: write, read back, and survive a restart.

### R9 — Safety

- Every tool that changes state irreversibly is `destructive: true`.
- Every destructive tool goes through the `ApprovalGate`.
- Tool failures return an error result, never an unhandled rejection.
- The audit trail records approval decisions (approved / rejected / timed
  out).

## Constraints

- **Stay inside `apps/server`.** Never edit `apps/web` or the workspace root.
- **Do not commit or push.** The coordinator commits after reviewing your
  summary.
- **One port.** The Express app owns port 8099. No new listeners, no
  separate dev server.
- **API stays under `/api/v1`.** MCP stays at `/api/v1/mcp`.
- **No hardcoded hosts, ports, credentials or model ids** in source.
- **Never commit `.env`** or any secret.
- **Zod stays at 4.6.7** and the **MCP SDK stays at 1.32.1**. Do not change
  either.
- **Keep the three layers separate:** transport (`src/mcp/`), tool execution
  (`src/tools/`), AI orchestration (`src/ai/`). The agent loop must not
  import the MCP transport.
- **Keep the implementation straightforward.** No plugin systems, no
  dependency injection frameworks, no premature abstraction. The brief
  explicitly asks for a readable implementation.
- **No AWS infrastructure** in this task. No CDK, no SAM, no deployed
  resources. Bedrock is called through the SDK; that is all.

## Acceptance criteria

- [ ] `npm test --workspace @muca/server` passes, with the original 21
      tests still green and new tests added.
- [ ] `npm run typecheck --workspace @muca/server` is clean.
- [ ] `npm run lint --workspace @muca/server` is clean.
- [ ] A destructive tool does **not** run without going through the
      `ApprovalGate` — proven by a test.
- [ ] The elicitation path and the HTTP fallback path both work, proven by
      tests.
- [ ] At least one tool is genuinely long-running and backed by MCP Tasks,
      with observable status and no leaked timers — proven by a test.
- [ ] The Bedrock adapter maps tool use correctly, proven by a unit test
      with a stubbed client.
- [ ] The Ops Copilot tool set works end to end against the seeded mock,
      with **no** external credentials required.
- [ ] Run history survives a server restart, proven by a test.
- [ ] Every new/changed REST route is documented in `SUMMARY.md` with
      exact request and response shapes.
- [ ] Every new env var is documented in `SUMMARY.md`.

## Verification

From `/mnt/ee/aprojects/zyrun/adh`:

```bash
npm test --workspace @muca/server
npm run typecheck --workspace @muca/server
npm run lint --workspace @muca/server

# live smoke test — start the server, then:
npm run dev --workspace @muca/server
curl -s http://localhost:8099/api/v1/health
curl -s http://localhost:8099/api/v1/tools
```

If you change the MCP surface, also re-run the live MCP probe described in
`AGENTS/mcp_protocol.md` and paste the output into `SUMMARY.md`.

## Out of scope

- Frontend work (`apps/web`).
- Deployment, IaC, AWS resources, CI/CD.
- Editing the root `package.json`, `AGENT.md`, `AGENTS/*`, `README.md`, or
  `.env.example`.
- Changing the zod or MCP SDK versions.
- A real GitHub / AWS integration that needs real credentials.
- Multi-tenant support, user accounts, billing.

## Notes

- Read `AGENTS/mcp_protocol.md` **before** you touch the MCP layer. It
  records the zod-unification trap and the pinned-version facts.
- The SDK's experimental Tasks API is in
  `node_modules/@modelcontextprotocol/sdk/dist/esm/experimental/tasks/`.
  Read the `.d.ts` files. Do not guess the API.
- Elicitation types are in
  `node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts`
  (`ElicitRequestFormParamsSchema`, `ElicitRequestURLParamsSchema`).
- `server.elicitInput(...)` is the server-side entry point. A client must
  declare the `elicitation` capability to receive the request.
- The current `Agent.run()` signature takes `approvedCallIds`. You will
  need to thread the `ApprovalGate` through. Keep the change minimal and
  keep `Agent` free of any MCP import.
- The current `McpHttpHandler` creates a new `McpServer` per session. That
  is correct and must stay.
