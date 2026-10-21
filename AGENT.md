# Muca — Coordinator & Delegation Protocol

> **Before starting any task or marking any task completed, read this entire
> file carefully and keep every task updated to match the task condition.
> Always read this file after completing a task and always update it before
> working on a new task.**

<agent-topology>

The user is the **COORDINATOR / PLANNER**. The main agent in this
conversation is the **HEAD agent** (planning, task authoring, review,
integration, commits). All other agents are separate **MAIN agents**, each in
its own session and working directory. They are **NOT** the `subagent` tool.

| Agent | Working directory | Owns |
|---|---|---|
| HEAD | `/mnt/ee/aprojects/zyrun/adh` | Planning, task files, review, integration, commits |
| FRONTEND | `/mnt/ee/aprojects/zyrun/adh/apps/web` | `apps/web` implementation only |
| BACKEND | `/mnt/ee/aprojects/zyrun/adh/apps/server` | `apps/server` implementation only |
| TESTER | `/mnt/ee/aprojects/zyrun/adh` | Independent verification of shipped changes; no product edits |

The user relays the HEAD's invocation message. The HEAD explicitly tells the
user WHEN to invoke which agent and the exact message to send. Repo agents
never commit/push; the HEAD reviews and commits.

- FRONTEND/BACKEND task lifecycle: HEAD writes
  `AGENTS/<AGENT>/TASK.md`; user relays "Read `AGENTS/<AGENT>/TASK.md` and
  complete it."; the agent works, writes `AGENTS/<AGENT>/SUMMARY.md`, renames
  `TASK.md` to `TASK-COMPLETE.md`. HEAD archives both to
  `AGENTS/<AGENT>/summaries/`, resets the marker, and writes the next task.
- **One agent, one folder (HARD RULE):** `AGENTS/BACKEND/` for BACKEND,
  `AGENTS/FRONTEND/` for FRONTEND, `AGENTS/TESTER/` for TESTER. Tasks and
  summaries are never shared across agents. See `AGENTS/INDEX.md`.
- TESTER reads `AGENTS/TESTER.md` and writes reports to
  `AGENTS/TEST_REPORTS/`.

See `AGENTS/repo_agent_protocol.md` and `AGENTS/TESTER.md`.

</agent-topology>

<instructions>

- Agent topology (HARD RULE): the user is the coordinator/planner; the main
  agent is the HEAD agent. `apps/web`, `apps/server` and TESTER are separate
  MAIN agents in their own sessions; they are **NOT** the `subagent` tool and
  never share a session. The HEAD translates user intent into
  self-contained tasks, tells the user exactly which agent to invoke and what
  to say, reviews the result, and commits. Repo agents never commit/push.
  See `AGENTS/repo_agent_protocol.md`.
- Delegation-first (HARD RULE): the HEAD should get ~99% of work done by
  agents, not by itself. HEAD only plans, writes task/prompt files, reads
  summaries, reviews diffs, runs integration checks too small to delegate,
  and commits. Product code goes to FRONTEND/BACKEND. Verification goes to
  TESTER. If the HEAD feels the remaining work is too heavy, it must tell the
  user and ask permission to delegate an additional agent.
- Invocation protocol: when an agent is needed, HEAD outputs a short
  `INVOKE: <AGENT>` block with the exact copy-paste message, then stays
  terse while the agent runs. HEAD gives its full assessment only after the
  agent returns. Never silently start work that should be delegated.
  - FRONTEND and BACKEND may run **in parallel** when the task contract is
    already fixed and neither depends on the other's output.
  - TESTER is invoked after any frontend/backend code change is ready for
    review, and after any bug fix. Scope is mandatory (feature + obvious
    regressions).
- TESTER runs at the workspace root, reads both apps, writes reports to
  `AGENTS/TEST_REPORTS/`, and never edits product code, `.env`, or commits.
- Each repo agent owns an isolated, persistent session context. It persists
  natively between tasks; the agent does not need a per-task memory file.
  `AGENTS/<AGENT>/SUMMARY.md` is the HEAD handoff. Agents must not rely on the user
  chat; every task is self-contained.
- **Single port (HARD RULE):** the Express server in `apps/server` hosts the
  Next.js app in `apps/web` and the API under `/api/v1`. `PORT=8099`. The
  browser only ever calls relative `/api/v1` paths. Never introduce a second
  port, a Vite proxy, a separate frontend dev server, or an absolute
  backend URL in the client bundle.
- **API prefix (HARD RULE):** the REST API lives under `/api/v1`. The MCP
  endpoint is `/api/v1/mcp`. Never move either without a HEAD task.
- **No hardcoded hosts, ports or credentials:** configuration lives in
  `.env` (template in `.env.example`). No `|| 'localhost:3000'` style
  fallbacks in source.
- **Secrets:** never commit `.env`, API keys or tokens. `.env*` is
  git-ignored except `.env.example`.
- **MCP contract (HARD RULE):** the server is `@modelcontextprotocol/sdk`
  pinned to an exact version, Streamable HTTP, stateful sessions, protocol
  `2025-11-25`. Tools are declared with Zod schemas in
  `apps/server/src/tools/`. Changing the SDK version means re-verifying
  protocol compatibility — see `AGENTS/mcp_protocol.md`.
- **Separation of concerns (HARD RULE):** transport, tool execution and AI
  orchestration stay in separate modules. The agent loop must not import the
  MCP transport; it talks to the `ToolRegistry`.
- **Destructive tools require user confirmation:** any tool that changes
  state irreversibly is registered with `destructive: true` and the agent
  must not run it without an approved call id.
- **Error handling (HARD RULE):** validate all tool arguments with Zod;
  never let a tool throw an unhandled rejection into the request. Tool
  failures return an error result, not a 500.
- **Verification:** use the repo check scripts; run `npm test` and
  `npm run typecheck` from the workspace root. Do not run a full production
  build for routine checks.
- No secrets or large code blocks in any agent file.

</instructions>

<projectInfo>

- [2026-10-22T01:20:00+06:00] **All three TESTER findings fixed and
  verified live against the real provider. The tree is clean.**

  BACKEND round accepted (commit `75d1b05`):
  - R1 (P1): the spent approval is retired unconditionally after the run,
    and `approvedCallIds` are de-duplicated, so one id cannot authorise
    two actions.
  - R2 (P2): `writes` is now an independent axis. Live `tools/list`
    confirms the annotations are honest — `readOnly=true` for exactly
    the six read-only tools, `destructive=true` for exactly
    `create_branch` and `open_pull_request`. The agent also found that
    `idempotentHint` had the identical flaw and corrected it too.
  - R3 (P3): the task runner decides expiry by what was waited, not by
    re-reading the clock; the agent modelled the race (100000/100000
    deterministic).

  **Live verification with a real model, after the fixes:**
  - the gateway selects `gemini (gemini-2.5-flash-lite)`;
  - a destructive request parks with the exact arguments;
  - **replaying a spent approval is refused** — the run parks again on
    the very same action and no tool runs (the P1, proven in the real
    path, not just in a test);
  - MCP `tools/list` reports 10 tools with correct annotations.

  276 tests pass (250 server + 26 web), typecheck and lint clean, tree
  clean.

  **Still unverified:** the **Anthropic** adapter has never been run
  against the real Anthropic API. Only Gemini has. The Anthropic path is
  structurally the same (a Messages API adapter with the same tool-call
  mapping) and its unit tests use an injected `fetch`, but the `$schema`
  class of bug is exactly the kind that only a real endpoint reveals.

- [2026-10-22T00:40:00+06:00] **The app has now been run against a real
  model. Three real defects found and fixed; the demo is unblocked.**

  The owner supplied a Google Gemini key. Until now **no real model call
  had ever succeeded** — every verification used a stub. Driving the real
  API found three defects that no stub could have caught, because a stub
  accepts any request:

  1. **Tool calling was broken against Gemini.** Zod v4 emits a complete
     JSON Schema document, but a provider accepts a schema *dialect*.
     Gemini rejected our tool parameters with HTTP 400 on **every** call:
     `Unknown name "$schema" at
     'tools[0].function_declarations[0].parameters'`. The probe still
     passed, because the probe sends no tools. The rejected-keyword list
     was read back from the API's own errors, not guessed; keywords that
     carry no meaning are dropped and the ones that do are translated
     (`const` → single-value `enum`, `exclusiveMinimum` → `minimum`).
  2. **The default Gemini model no longer exists** — `gemini-2.0-flash`
     was retired by Google, so a key with no model configured 404s.
  3. **The probe budget was too tight.** A cold real call takes ~1 s when
     healthy but up to 20 s when the provider is throttling; a 4 s budget
     reported a working key as unusable and **silently disabled the
     agent**. The default is now 10 s.

  Also: Google's free tier is **per model** — `gemini-2.5-flash` allows
  20 requests a day on this key and was exhausted by testing, while
  `gemini-2.5-flash-lite` has its own, much larger allowance. The default
  is now the lite model.

  **Verified live, end to end:** the gateway selected
  `gemini (gemini-2.5-flash-lite)` with the probe `ok` in ~1.1 s; the
  agent called `list_deployments`, then `get_deployment` with the id from
  the first result, and answered from the evidence; a destructive request
  **parked** with the exact arguments; approving an action the user had
  not seen was **refused** and parked again (the P1 fix, live); approving
  the correct action ran the tool — `Created branch "fix-a-bug" from
  "main".` — and the model summarised it.

  **FRONTEND round accepted** (commit `5be15cd`). The two-row timeline
  defect is fixed: the server records `approval_decision { approved:
  false }` *before* it asks, and the old timeline applied that decision
  on the spot, so the row became DECLINED and the confirmation pushed a
  second row. Status is now decided in a second pass, after every event
  is known. Verified by screenshot: one row, `WAITING`, approval card
  intact. The web app also gained **26 tests** (vitest) — it had none.
  Note: my own diagnosis of this bug (a `callId`/`id` mismatch) was
  wrong — the REST layer normalises every event to `id`; the ordering
  was the real cause.

  The web agent's note that the root `npm test` only ran the server
  workspace is fixed: it now runs both (250 + 26 = 276 tests).

- [2026-10-21T23:30:00+06:00] **TESTER round complete: PASS WITH RISKS.
  Two P1s found, one fixed by the coordinator, one dispatched. Both
  remaining fixes are dispatched.**

  The TESTER's report is thorough and, unusually, honest about its own
  limits: it reported that HEAD moved under it, that the provider gateway
  landed uncommitted mid-run, and that §G was therefore verified against
  an uncommitted snapshot. It also confirmed the P1 I had already fixed
  (argument binding) still holds, and re-verified the fresh-clone install
  from a clean checkout.

  **Fixed by the coordinator (root, `2af90d6`):** the root `npm run dev`
  ran only the web workspace, so the command every document pointed at
  served the frontend and nothing else — `/api/v1/health` was 404 and
  there was no MCP endpoint. The README promised one process on one port;
  the script did not do it. Now it runs the server workspace, which
  mounts Next.js itself. Verified live: `/` 200, `/api/v1/health` 200,
  `/api/v1/mcp` 400 (alive). The README was also rewritten: it still
  described the placeholder note tools, a single OpenAI provider and the
  old boot banner.

  **P1 (fixed, `9587bc1`):** a spent approval can be **replayed**. The
  pending-approval registry retires a consumed id only when the run does
  *not* park, so if the run parks again on a different action the stale
  entry stays and re-authorises its action. Reproduced with a new
  regression test that fails by design.

  **P2 (dispatched to BACKEND):** `readOnlyHint` is derived from the
  *destructive* flag, so `create_issue` and `comment_on_issue` are
  published as read-only even though they write. The two axes are
  different and the catalogue must carry both.

  **P2 (dispatched to FRONTEND):** the timeline shows **two rows** for a
  parked tool call, one wrongly labelled `DECLINED`. Root cause: the
  server's event union uses `id` for tool events and `callId` for the two
  approval events, while the frontend's parser reads `record.id` for
  every type — so the fold that turns a call into its approval row never
  matches. The frontend also has **no test suite at all**; one is
  required.

  **Also dispatched (BACKEND):** the task-timeout test is flaky — the
  runner's deadline check depends on `setTimeout` jitter. A judge running
  `npm test` must not see a coin flip.

  **Verified working (coordinator):** the provider gateway boots with no
  keys (`auto → none`, all three `not_configured`, `enabled: false`), and
  the timeout path is real — with the dummy local key the OpenAI probe
  timed out after 4004 ms and the server still booted. 229 tests across
  17 files; typecheck and lint clean.

- [2026-10-21T20:10:00+06:00] **New requirement: AI provider gateway with
  parallel probing. Dispatched to BACKEND.**

  The operator wants Muca to work with whichever key they have, instead of a
  single hardcoded provider:

  - `ANTHROPIC_{API_KEY,ENDPOINT,MODEL}`, `OPENAI_{API_KEY,ENDPOINT,MODEL}`,
    `GEMINI_API_KEY` (key only; endpoint and model defaulted).
  - `AI_PROVIDER=auto` (new default): probe every configured endpoint **in
    parallel** at startup and use the highest priority that answers —
    **anthropic > openai > gemini**.
  - The probe is a real minimal request (`max_tokens: 1`) with a timeout, and
    the result is a **status**, not a boolean: `ok` / `throttled` (429 — the
    key is valid, so it counts as usable) / `invalid_key` / `bad_request` /
    `unreachable` / `timeout` / `not_configured`.
  - If both Anthropic and OpenAI pass ⇒ Anthropic. If one passes ⇒ that one.
    If none pass ⇒ `enabled: false`, and the server still boots: MCP, tools
    and demo mode do not need a model. Gemini is the lowest priority, not an
    unconditional fallback.
  - Explicit `AI_PROVIDER=<name>` still probes for honesty but does **not**
    silently switch providers.
  - Scope is the I/O gateway only — prompt in, answer out. MCP, tools and
    approval are untouched. Bedrock keeps working, outside the auto priority.

  Two new adapters (Anthropic Messages API, Gemini `generateContent`) behind
  the existing `AIProvider` interface, using global `fetch` — no new
  dependencies. The known trap: Gemini's `functionCall` has no call id, so
  the adapter must synthesise a stable unique id per call or the agent loop
  cannot match tool results back.

  `GET /api/v1/health` keeps `enabled` and `provider` (the web client reads
  them) and adds `mode` and `probes`. `POST /api/v1/ai/probe` re-runs the
  probes for the demo without hot-swapping.

  Root `.env.example` already documents the new variables. The 9-vs-10 tool
  catalogue fix is folded in as Part B of the same task.

- [2026-10-21T19:35:00+06:00] **BACKEND and FRONTEND both returned; the P1
  is fixed and both are committed. One dedicated folder per agent.**

  **BACKEND P1 fix — verified independently, accepted.** Commit `26d568e`.
  An approval is now an `ApprovedAction` (tool + exact arguments) compared
  canonically and consumed once. Zod defaults are resolved on both sides
  through the `ToolRegistry`, so an omitted `baseBranch` and a spelled-out
  one are the same action. The registry is the authority on which call ids
  were issued.

  The agent found and closed **two further holes in the same class**, both
  unprompted and both correct:
  1. The agent honoured a client-supplied `approvedCallIds` entry without
     consulting the gate, so an invented id could authorise a destructive
     call. The bypass is removed.
  2. Its own first implementation kept an exact-call-id path, on the
     reasoning that an id identifies an action. That reasoning was wrong:
     the model may reuse a call id. The id now only records provenance;
     the arguments decide.

  Coordinator's independent probe (`tests/approval-gate-adversarial.test.ts`,
  8 assertions, written from the threat model rather than from the agent's
  tests) passes — including one that passes `fallback: async () => true` to
  prove the gate never consults a client-supplied shortcut. Full suite:
  **154 tests across 13 files**, typecheck and lint clean.

  **FRONTEND — verified, accepted.** Commit `fda441c`. The browser is a
  real MCP client (`@modelcontextprotocol/sdk` `Client` +
  `StreamableHTTPClientTransport`) against the same-origin `/api/v1/mcp`:
  live session id, negotiated `2025-11-25`, discovered tools, raw JSON-RPC
  log. Timeline instead of a chat transcript; artifact cards for
  deployments, CI failures, branches, PRs and issues; labelled scripted
  demo mode that works with no API key.
  Verified: typecheck, lint and **production build** clean; 10 captured
  screenshots under `/tmp/opencode/shots-final/` reviewed by the
  coordinator.

  **Agent folders.** Commit `ed02c23`. Every agent now has its own
  channel: `AGENTS/BACKEND/`, `AGENTS/FRONTEND/`, `AGENTS/TESTER/`, each
  with `TASK.md` / `TASK-COMPLETE.md` / `SUMMARY.md` / `summaries/` /
  `README.md`. `AGENTS/INDEX.md` is the map; the protocol and both app
  `AGENT.md` files point at the new paths.

  **Hygiene fix.** The root `.gitignore` only ignored `/node_modules`, so a
  Vitest cache under `apps/server/node_modules` had been committed. Now
  `node_modules/` at any depth, plus `.muca/`.

  **Open, known issues:**
  - `diagnose_incident` is registered only in the MCP layer, so
    `GET /api/v1/tools` and `/health` report **9** tools while `tools/list`
    reports **10**. The UI unions both and stays correct, but the two
    catalogues should agree. Dispatched as a small BACKEND task.
  - The demo-mode timeline can show an earlier, cancelled attempt as
    `DECLINED` above a fresh `WAITING` row for the same tool. Cosmetic;
    it is genuine history, not a duplicate.
  - Muca's use case and the Bedrock-vs-OpenAI default are still the
    coordinator's proposed defaults (Ops Copilot; OpenAI default with
    Bedrock implemented and selectable), not confirmed by the owner.

- [2026-10-21T17:00:00+06:00] **BACKEND agent returned; reviewed and
  committed. One P1 safety finding dispatched as a follow-up.**

  Accepted: Elicitation, MCP Tasks, Bedrock adapter, Ops Copilot tool set,
  run history, new REST routes. **118 backend tests pass, typecheck and
  lint clean**, verified independently by the coordinator (not taken on
  trust).

  Independently verified by the coordinator:
  - Live MCP handshake over real HTTP: `serverInfo` = `muca-mcp 0.2.0`,
    capabilities now include `tasks: {list, cancel, requests}`.
  - `tools/list` returns the Ops Copilot set with `destructiveHint` on
    `create_branch` and `open_pull_request`.
  - A destructive tool called by a client **without** the elicitation
    capability is correctly refused ("The user declined to run
    create_branch. Nothing was changed.") — the fail-closed path works.
  - The mock adapters are deterministic across instances and across calls,
    and the data genuinely correlates (deployment `ciRunId` → CI run →
    matching open issue), so a real multi-step agent workflow works.
  - Path traversal through the run-id parameter is contained.
  - The frontend contract lines up: the BACKEND agent's response shapes
    match what the FRONTEND agent has already written in
    `apps/web/lib/api.ts`. The backend returns **no** `artifacts` field and
    the frontend correctly treats it as absent.

  **P1 finding (dispatched to the BACKEND agent).** The web (HTTP)
  approval path binds the approval to the **tool name**, not to the
  **arguments the user actually saw**. Reproduced against the live code:
  the user approved `create_branch(name="feature/approved")` and the
  server executed `create_branch(name="attacker-controlled")`. The
  `PendingApprovalRegistry` stores the parked arguments but does not
  consult them when matching. This undermines the product's central
  "permission-aware" claim and is exactly what a judge probing the
  permission model would find.

  The **MCP/elicitation path is not affected** — the server asks the
  client inside the same tool call, with that call's arguments.

  A regression test already exists and currently **fails**:
  `apps/server/tests/approval-argument-binding.test.ts`. It is the
  specification for the follow-up task.

  Also noted: the previous task's claim that the baseline `typecheck` and
  `lint` were already failing is **true** — the coordinator had not run
  them since the frontend work began. Both are now clean.

- [2026-10-21T14:25:00+06:00] **Plan written; two parallel tasks dispatched.**
  `AGENTS/PLAN.md` records the full strategy: why MCP `2025-11-25` over
  Streamable HTTP is the qualifying requirement for the Alexa+ track
  (Option A), the judging axes, and the phase plan.

  Research findings that changed the plan (all verified against the pinned
  SDK, not assumed):
  - The SDK's `LATEST_PROTOCOL_VERSION` in `1.32.1` **is** `2025-11-25`, so
    the protocol requirement is satisfied by construction.
  - **MCP Elicitation exists** in the pinned SDK (`server.elicitInput()`,
    `ElicitRequestFormParams` / `ElicitRequestURLParams`). This is the
    protocol-native replacement for our ad-hoc `approvedCallIds` gate.
  - **MCP Tasks exist** in the pinned SDK
    (`@modelcontextprotocol/sdk/experimental/tasks/`). This is the
    protocol-native replacement for a bespoke long-running job system.
  - Amazon explicitly labels "a basic MCP wrapper around an existing API" as
    obvious, and credits "agentic workflow that orchestrates across
    services" plus "state maintained across sessions". The current
    placeholder tool set is exactly the "wrapper" shape, so it must change.
  - **Hard deadline: October 23, 2026.** Optimise for a demonstrable,
    judge-runnable product, not a platform.
  - Elicitation requires the *client* to declare the `elicitation`
    capability. A plain browser page cannot receive an elicitation request
    directly, so the design keeps both paths behind one `ApprovalGate`:
    Elicitation for MCP clients, HTTP approval for the web client.

  Recommended direction (pending coordinator confirmation): an **Ops
  Copilot** for solo developers and small teams — deployment/CI failure
  triage across services, with a permission-aware safety model, seeded mock
  adapters so judges need no secrets, and Bedrock as a second provider
  behind the existing `AIProvider` interface (which also qualifies for the
  separate AWS Builder mini-challenge prize).

  Dispatched in parallel (the contract is already fixed, so neither blocks
  the other):
  - `AGENTS/BACKEND/TASK.md` — BACKEND: `ApprovalGate` + Elicitation,
    MCP Tasks, Bedrock adapter, Ops Copilot tool set against seeded mocks,
    session-scoped run history, new REST routes, new tests.
  - `AGENTS/FRONTEND/TASK.md` — FRONTEND: timeline view instead of a chat
    transcript, artifact cards, a **visible MCP handshake panel** (session
    id, discovered tools, raw JSON-RPC log) to prove protocol compliance at
    runtime, and a clearly-labelled demo mode that works with no API key.
  - TESTER is invoked once both return.

  Both tasks are written to tolerate a moving backend: the frontend is told
  to build defensively against the current stable contract and to not
  block on the backend's new routes.

  **Status:** skeleton shipped and verified (21 tests green, typecheck
  clean, live MCP handshake confirmed). Awaiting the two agent returns.

- [2026-10-21T14:05:00+06:00] **Skeleton shipped.** The repository is
  restructured into an npm-workspaces monorepo: `apps/server` (Express + MCP
  + agent loop) and `apps/web` (Next.js 16 + React 19 + Tailwind 4). One
  process, one port (`8099`): Express mounts the REST API and the MCP
  Streamable HTTP endpoint under `/api/v1` and delegates everything else to
  the Next.js request handler.

  Verified working:
  - MCP `initialize` handshake over real HTTP with a real SDK client;
    `serverInfo` = `muca-mcp 0.1.0`, capabilities = `{tools:{listChanged:true}}`.
  - `tools/list` returns 7 tools with JSON Schema input schemas and
    `destructiveHint` annotations (`delete_note`, `clear_notes` are destructive).
  - `tools/call` executes, validates arguments (invalid input ⇒ `isError`
    with a Zod message), and preserves state across calls in a session.
  - `GET /api/v1/health`, `GET /api/v1/tools`, `POST /api/v1/chat` all respond
    correctly; `GET /` returns 200 with the Next.js app.
  - 21 backend tests pass (`npm test`): MCP protocol, tool discovery,
    tool execution, agent tool-calling loop, REST API.
  - `npm run typecheck` is clean for both workspaces.

  Key decisions:
  - `@modelcontextprotocol/sdk` pinned to `1.32.1`; `LATEST_PROTOCOL_VERSION`
    in that release is `2025-11-25`, which is the advertised version.
  - Zod unified on `4.6.7` via a root `overrides` entry. Without it npm
    installed both zod 3.25.76 and 4.6.7, and the SDK's
    `zod-to-json-schema` import failed at runtime. This is a real trap.
  - `next` is hoisted to the workspace root, so `apps/web/next.config.ts`
    sets `turbopack.root` to the workspace root. Without it Turbopack fails
    with "Could not find the Next.js package".
  - `next` is a CJS module whose export *is* the factory function, so the
    server imports it as `nextModule.default` and casts it.

  **Status:** the use case is NOT finalised. The seven tools in
  `apps/server/src/tools/index.ts` are placeholders that prove the pipeline.
  The next milestone is the real use case, then its tools.

</projectInfo>
