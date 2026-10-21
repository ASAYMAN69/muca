# Muca — Amazon Developer Hackathon 2026 (Alexa+ track)

**Status:** skeleton shipped and verified. Use case now scoped to an
"Ops Copilot" direction; final tool set pending coordinator decision.

---

## 1. Why MCP, and why this protocol version

### The qualifying requirement

For the **Alexa+ track**, a submission can be:

1. A working **Agent Skill**
2. A **self-hosted MCP server implementing MCP `2025-11-25` (or later) over
   Streamable HTTP**, or
3. A simulated Alexa+ experience using any agentic stack

Muca targets **option 2**, with a web page acting as a real MCP client
(`initialize` → `tools/list` → `tools/call`) as the demo path. This is
explicitly accepted by Amazon.

**Protocol:** `2025-11-25` is `LATEST_PROTOCOL_VERSION` in
`@modelcontextprotocol/sdk@1.32.1` — the version this repo pins. The
constraint is satisfied by construction, not by hope.

### What MCP actually changes vs. hand-rolled tool calling

The honest answer: **MCP does not make the tool loop smarter.** The loop is
the same shape in both cases — describe tools, call, read results, repeat.
What MCP replaces is the *glue around the loop*:

| Hand-rolled tool calling | MCP `2025-11-25` |
|---|---|
| Private function schema + private dispatch | Standard `tools/list` / `tools/call` |
| Every client needs a bespoke integration | Any MCP host (Claude Desktop, Amazon Q, Kiro, another agent) can connect unchanged |
| Ad-hoc capability negotiation | `initialize` handshake, capability advertisement, protocol negotiation |
| Hand-rolled confirmation UI | **Elicitation** — the server asks the *client* for structured input |
| A custom job table + polling endpoint | **Tasks** — a request becomes a pollable long-running workflow |
| Custom OAuth discovery | OAuth/OIDC discovery, improved incremental scope consent |
| Server-side model calls need bespoke plumbing | **Sampling** — the server can request a completion from the client |

### Why this is strategically different for a hackathon

The differentiator is **interoperability, not capability**. Muca's tool
server is not "Muca's private API" — it is an agent capability server. The
same server that the web client uses today works with any MCP-compatible
host tomorrow, with no rewrite.

That also gives a *demonstrable* story for judges: they can point their own
MCP client at the deployed URL and call the tools. That is a much stronger
submission than a chat box.

### What the SDK already gives us (verified in the pinned version)

- `McpServer` with `registerTool`, JSON Schema publication, argument
  validation.
- `StreamableHTTPServerTransport` — stateful sessions, SSE, `DELETE`.
- **Elicitation** — `server.elicitInput(...)` with
  `ElicitRequestFormParams` / `ElicitRequestURLParams`. This is the
  protocol-native replacement for our ad-hoc approval flow.
- **Tasks** — `experimental/tasks/` with a task server, stores, and
  pollable status. This is the protocol-native replacement for a bespoke
  long-running job system.
- **Sampling** — let the server ask the client's model for a completion.

**Recommendation:** use **Elicitation** for the destructive-action gate
(replacing the current `approvedCallIds` mechanism) and **Tasks** for any
long-running operation. Both are protocol-native, and judges can see them
in the wire traffic.

---

## 2. Stack, and the one-origin / one-port rule

### Current shape (already implemented)

```
PORT 8099 — one Express process
├── /api/v1/mcp      MCP Streamable HTTP endpoint
├── /api/v1/health   REST
├── /api/v1/tools    REST
├── /api/v1/chat     REST → agent loop → provider
└── /*               Next.js frontend (mounted programmatically)
```

`apps/server` owns the Express server and mounts `apps/web`'s Next.js
request handler. No Vite proxy, no second port, no absolute backend URL in
the client bundle.

### Recommendations

| Layer | Choice | Note |
|---|---|---|
| Frontend | Next.js 16 App Router + React 19 + Tailwind 4 | Already in place |
| Server | Express 5 + TypeScript ESM | Already in place |
| MCP | `@modelcontextprotocol/sdk@1.32.1`, Streamable HTTP | Pinned exactly |
| Validation | Zod 4.6.7 | **Unified via root `overrides`** — see `AGENTS/mcp_protocol.md` |
| Model | **Amazon Bedrock** (Claude) via the AWS SDK | Strongly recommended: it also qualifies for the AWS Builder mini-challenge, which is a separate prize track |
| Durable state | DynamoDB | Only if the product needs persistence |
| Async jobs | **MCP Tasks** (protocol-native) *before* SQS/Lambda | Prefer the protocol-native primitive; do not rebuild it |
| Auth | Cognito or Auth.js | Only if the product needs accounts |
| Hosting | Lambda + Function URL, or ECS Fargate | The FAQ calls Lambda a good low-cost MCP fit |
| Observability | CloudWatch + OpenTelemetry | Makes the agent's decisions inspectable |

### The routing discipline

- `/api/v1/*` — product APIs the React app calls.
- `/api/v1/mcp` — the standardized, agent-facing capability surface.
- Both call the **same service layer** underneath.

That separation is the architecture story: *humans use the product UI,
agents use MCP, both operate on the same domain services.*

**Do not** let `/api/v1` and `/api/v1/mcp` duplicate responsibilities.

---

## 3. What Amazon is actually looking for

Judging is weighted across four axes:

1. **Tech implementation** — quality and effective use of the required tech.
2. **Design** — a complete, coherent, intuitive product experience.
3. **Potential impact** — a credible real customer need beyond the hackathon.
4. **Quality of idea** — creative, non-obvious use of the ecosystem.

Amazon explicitly labels a **"basic MCP wrapper around an existing API"** as
obvious. It calls creative Alexa+ work things like autonomous multi-service
orchestration, state maintained across sessions, purchasing, media/carousels,
MCP Apps, and Agent Skills.

### The thing that wins

> **An MCP-native Ops Copilot for solo developers and small teams.**
>
> One conversational workflow that spans several services, with a
> permission-aware safety model.

A developer says:

> "Check the failing deployment, find the likely cause, open a fix PR, and
> notify the team — but ask me before pushing anything."

The MCP server orchestrates GitHub / AWS / issue tracker / chat, uses
Elicitation for approvals, and Tasks for the long-running diagnosis.

**Why it can win:**

| Axis | Why it scores |
|---|---|
| Tech implementation | Real MCP `2025-11-25`, Streamable HTTP, tool discovery, Elicitation, Tasks, Bedrock, Lambda/DynamoDB |
| Design | A timeline UI showing live tool calls, evidence, approvals and artifacts — not a chat box |
| Impact | Solo devs genuinely lose hours to deploy/CI incidents |
| Idea quality | An orchestration + safety layer, not a thin API wrapper |

### The safety differentiator

Most hackathon agents demo reckless autonomy. Make this one visibly
**permission-aware**:

- Read-only tools run automatically.
- Write tools require typed Elicitation: "Create branch?", "Open PR?",
  "Restart service?"
- Destructive actions require explicit approval **and leave an audit trail**.
- Long operations use MCP Tasks with clear status: `queued`, `running`,
  `awaiting_input`, `completed`, `failed`.
- Every tool result is explainable: source, timestamp, next action.

---

## 4. The plan, in phases

### Phase 1 — Qualifying skeleton ✅ DONE

- [x] Next.js app with `/`, `/api/v1/*`, `/api/v1/mcp`
- [x] MCP server: `initialize`, `tools/list`, `tools/call` over Streamable HTTP
- [x] Real MCP client (SDK `Client`) verifying discovery + execution
- [x] Seven working tools, two of them destructive
- [x] Agent loop with tool calling, argument validation, and a
      confirmation gate
- [x] React client showing live tool calls and the confirmation prompt
- [x] 21 passing tests, clean typecheck

### Phase 2 — Make it a *product* (NEXT)

Two parallel tracks, because the contract is already fixed:

**Track A — BACKEND agent** (the protocol-native upgrade + the product
surface):
- Replace the ad-hoc `approvedCallIds` gate with **MCP Elicitation**.
- Add **MCP Tasks** for the long-running diagnosis workflow.
- Replace placeholder tools with the **real Ops Copilot tool set**
  (deployments, CI failures, PRs, issues, notifications).
- Move the model to **Amazon Bedrock** behind the existing `AIProvider`
  interface — the interface was designed for exactly this.
- Persist runs/tasks/audit in **DynamoDB**.

**Track B — FRONTEND agent** (the judge-facing product):
- Replace the chat box with a **timeline** view: request → tool calls →
  evidence → approval → outcome.
- Add **artifact cards** (incident, PR, log excerpt, remediation plan).
- Add a **demo mode** with seeded data so judges can reproduce the flow
  with no secrets.
- Make the **MCP handshake visible** — show the session id, the discovered
  tool list, and the raw JSON-RPC traffic. This is the single highest-value
  UI change for this specific track: it proves the protocol is really
  being used.

### Phase 3 — Deployment + submission

- Deploy the MCP server to Lambda (Function URL) or ECS Fargate.
- Verify the public URL works with an external MCP client.
- Record a **sub-3-minute demo video** showing: the MCP handshake, tool
  discovery, task progress, an approval prompt, and the completed outcome.
- Submission assets: repo with setup instructions + license, the video, API
  feedback, AWS Builder mini-challenge docs, and the **friction log**
  (up to a 10% judging bonus).
- **Clear evidence that MCP is actually invoked at runtime**, not just
  mentioned in the README.

### Hard deadline

**October 23, 2026.** Optimize for a demonstrable, judge-runnable product —
not a platform. Do not build a universal MCP platform, a plugin
marketplace, or multi-tenant SaaS.

---

## 5. Decisions we need from the coordinator

1. **The real use case.** The current placeholder tools are proven but
   generic. Which concrete domain?
   - **Option A (recommended):** Ops Copilot — deploy/CI/PR triage and
     remediation. Strongest on all four judging axes; needs mock or real
     GitHub/AWS adapters.
   - **Option B:** Personal assistant domain (expenses, calendar, home
     logistics). Narrower impact, easier to demo end-to-end.
2. **Bedrock or keep OpenAI?** Bedrock qualifies for the AWS Builder
   mini-challenge (a separate prize). The `AIProvider` interface means
   both are cheap. Recommendation: implement Bedrock, keep OpenAI as the
   default for local dev.
3. **Demo data strategy.** Seeded mock adapters (no secrets, judges can
   reproduce) vs. real API integrations (more impressive, more fragile).
   Recommendation: mock adapters with a clearly labelled live mode.
4. **Elicitation vs. the current approval flow.** Elicitation is
   protocol-native but requires the *client* to handle the request. If the
   web client stays a plain browser page, the current HTTP-level approval
   is simpler. Recommendation: implement **both** — Elicitation for MCP
   clients, HTTP approval for the web client — behind one
   `ApprovalGate` interface.
