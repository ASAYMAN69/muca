/**
 * The approval gate.
 *
 * Muca has two front doors onto the same tool registry:
 *
 *   - **MCP clients** (Claude Desktop, Amazon Q, any MCP host). These speak
 *     the protocol, so the server can ask them for a decision using
 *     **Elicitation** — the protocol-native "ask the user" primitive.
 *   - **The web client**, which is a plain browser page and cannot receive
 *     an elicitation request. It approves a call id over plain HTTP.
 *
 * Both paths implement the same tiny interface, so the agent loop never has
 * to know which one it is talking to.
 */

/** What the agent wants to run, and why it wants to run it. */
export interface ApprovalRequest {
  toolName: string;
  title: string;
  message: string;
  arguments: Record<string, unknown>;
}

/**
 * A specific, user-visible action: a tool plus the exact arguments it
 * would run with.
 *
 * An approval is a statement about *an action*, not about *a tool*. The
 * user saw `create_branch(name="feature/approved")` on screen and clicked
 * *Approve*; that authorises exactly that call and nothing else. A later
 * `create_branch(name="something-else")` is a different action and needs a
 * fresh approval.
 */
export interface ApprovedAction {
  /**
   * The call id the action was parked under.
   *
   * It records *which* parked call the approval came from, so the audit
   * trail can point back at the exact thing the user saw. It is
   * deliberately **not** what authorises a call: the id in a tool call
   * comes from the model, and the model may reuse one, so matching on the
   * id alone would let a different action run under an approved id.
   */
  callId: string;
  toolName: string;
  /**
   * The arguments of the action, exactly as the user saw them.
   *
   * They may be raw (as the model produced them) or parsed (after Zod
   * defaults are applied). The gate normalises both sides before
   * comparing, so the two forms of the same action match.
   */
  arguments: Record<string, unknown>;
}

/**
 * Normalises a tool's arguments into a canonical, comparable form.
 *
 * The tool's Zod schema is applied so that defaults are resolved: a call
 * that omits `baseBranch` and one that spells out `baseBranch: "main"` are
 * the same action.
 */
export type ArgumentNormaliser = (
  toolName: string,
) => ((args: Record<string, unknown>) => Record<string, unknown>) | undefined;

/**
 * The authority on which call ids the server actually issued.
 *
 * The client sends back the call ids it approved, but the client is not
 * trusted: it could send any string. The registry is what the server
 * issued, so it is what decides whether an id is real.
 *
 * A minimal implementation is a `Set` of issued ids.
 */
export interface IssuedCallIds {
  has(callId: string): boolean;
}

/**
 * Compares two argument objects for **semantic** equality.
 *
 * Key order does not matter, and JSON-equivalent values compare equal. But
 * a different value never matches — which is the whole point: an approval
 * must not carry over to a different action.
 *
 * The comparison is deliberately strict about *types*: `"1"` and `1` are
 * different arguments, because they may mean different things to the tool.
 */
export function argumentsMatch(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  return canonicalize(a) === canonicalize(b);
}

/**
 * Renders an argument object as a canonical string.
 *
 * Keys are sorted, so `{a:1,b:2}` and `{b:2,a:1}` produce the same string.
 * Values are rendered by type, so a string never equals a number.
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
  }

  if (typeof value === 'number') {
    // `NaN` and `Infinity` are not JSON, so they cannot come from a
    // parsed tool call, but they must not compare equal to anything.
    return Number.isFinite(value) ? `n:${value}` : `n:${String(value)}`;
  }

  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'boolean') return `b:${value}`;

  return `x:${String(value)}`;
}

/**
 * The outcome of asking for approval.
 *
 * `pending` means "nobody has decided yet" — the run is parked and the
 * user still has to answer. It is not a refusal.
 */
export type ApprovalDecision =
  | 'approved'
  | 'rejected'
  | 'timed_out'
  | 'pending';

export interface ApprovalGate {
  request(input: {
    approval: ApprovalRequest;
    /** Unique id for this request; used to correlate the approval. */
    requestId: string;
    /** When the client cannot elicit (plain HTTP), fall back to this. */
    fallback: () => Promise<boolean>;
  }): Promise<boolean>;

  /**
   * Which path this gate speaks. Used to label the audit trail and the
   * agent events. Optional, so a minimal gate implementation still works.
   */
  readonly source?: ApprovalSource;
}

/**
 * The two ways an approval can be obtained.
 *
 * `policy` is the live path: the server decides from the user's own
 * policies, over the WebSocket.
 */
export type ApprovalSource = 'elicitation' | 'http' | 'fallback' | 'policy';

/**
 * A gate that can also say *"nobody has decided yet"*.
 *
 * The plain-HTTP path needs this. A browser page cannot answer an
 * elicitation, so the first request parks the run and returns a
 * `pendingCall`; the user clicks *Approve* and the next request carries
 * the approved call id.
 *
 * The extra capability is **optional**: a gate that only implements
 * `request()` is still a complete gate, and a refusal is simply a
 * refusal. A gate that defers is never allowed to run the tool.
 */
export interface DeferrableApprovalGate extends ApprovalGate {
  /**
   * True when the decision is still outstanding — the run should wait for
   * the user rather than treat this as a refusal.
   */
  isPending(requestId: string): boolean;
}

/** True when the gate supports deferring. */
export function isDeferrable(gate: ApprovalGate): gate is DeferrableApprovalGate {
  return typeof (gate as DeferrableApprovalGate).isPending === 'function';
}

/**
 * Records every approval decision so the audit trail can show what the user
 * actually said, not just that a tool ran.
 */
export interface ApprovalAudit {
  record(entry: {
    requestId: string;
    toolName: string;
    decision: ApprovalDecision;
    /** Which path produced the decision. */
    source: ApprovalSource;
    at: string;
  }): void;
}

/** An audit sink that discards everything. Used when no store is wired up. */
export const noopApprovalAudit: ApprovalAudit = {
  record: () => undefined,
};

/**
 * The HTTP approval path.
 *
 * The web client already has the "approve this call id" flow: it sends the
 * approved call ids with the next `/api/v1/chat` request. This gate turns
 * that list into a yes/no answer for one specific call.
 *
 * An approved call id can authorise a call in two ways:
 *
 *   - by **exact call id** — the id the server handed out in `pendingCall`.
 *     The model usually produces a fresh id, so this rarely fires.
 *   - by **matching the parked action** — the same tool *and* the same
 *     arguments as the parked call. This is the path the web client
 *     actually exercises, because the model re-asks with a new id.
 *
 * The second path is what makes an approval a statement about an *action*
 * rather than a licence to invoke a *tool*. If the model asks for
 * `create_branch(name="other")` after the user approved
 * `create_branch(name="feature/approved")`, the arguments do not match and
 * the call is **not** approved.
 *
 * Every approval is **consumed** by the first call it authorises, so one
 * approval can never authorise two different actions.
 */
export class HttpApprovalGate implements DeferrableApprovalGate {
  readonly source: ApprovalSource = 'http';

  /**
   * The parked actions that were approved. Consumed one each.
   *
   * These come from the `PendingApprovalRegistry`, which is the authority
   * on which call ids the server actually issued. A client cannot invent
   * an approval by sending an arbitrary id.
   */
  private readonly approvedActions: ApprovedAction[];
  /** The requests that are still waiting for a decision. */
  private readonly pending = new Set<string>();
  /**
   * Resolves a tool's canonical arguments.
   *
   * Optional: without it the arguments are compared as they are. With it,
   * Zod defaults are applied on both sides, so a call that omits a
   * defaulted field and one that spells it out are the same action.
   */
  private readonly normalise: ArgumentNormaliser | undefined;

  constructor(
    approvedActions: Iterable<ApprovedAction> = [],
    private readonly audit: ApprovalAudit = noopApprovalAudit,
    normalise?: ArgumentNormaliser,
  ) {
    this.approvedActions = [...approvedActions];
    this.normalise = normalise;
  }
  async request(input: {
    approval: ApprovalRequest;
    requestId: string;
    fallback: () => Promise<boolean>;
  }): Promise<boolean> {
    const { approval, requestId } = input;

    // An approved *action* authorises a call that makes exactly the same
    // action. The approval is consumed, so it cannot be replayed.
    //
    // The action must match on **both** the tool and the arguments.
    //
    // The parked call id is *not* sufficient on its own. The id in a
    // tool call comes from the model, and the model is free to reuse an
    // id it used before — including the id of a call the user approved.
    // Matching on the id alone would let the model run a *different*
    // action under an approved id, which is exactly the bug this
    // replaces. The id only ever narrows *which* approval is considered;
    // the arguments decide.
    const index = this.approvedActions.findIndex((action) => {
      if (action.toolName !== approval.toolName) return false;
      return argumentsMatch(
        this.canonical(action.toolName, action.arguments),
        this.canonical(approval.toolName, approval.arguments),
      );
    });

    if (index !== -1) {
      this.approvedActions.splice(index, 1);
      this.pending.delete(requestId);
      this.audit.record({
        requestId,
        toolName: approval.toolName,
        decision: 'approved',
        source: this.source,
        at: new Date().toISOString(),
      });
      return true;
    }

    this.pending.add(requestId);
    this.audit.record({
      requestId,
      toolName: approval.toolName,
      decision: 'pending',
      source: this.source,
      at: new Date().toISOString(),
    });
    return false;
  }
  /** The decision is outstanding when the call was not approved. */
  isPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * Resolves a tool's arguments to their canonical form.
   *
   * The tool's Zod schema is applied when one is available, so Zod
   * defaults are resolved. A call that omits `baseBranch` and a parked
   * call that spelled out `baseBranch: "main"` are then the same action.
   */
  private canonical(
    toolName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const normalise = this.normalise?.(toolName);
    if (!normalise) return args;
    try {
      return normalise(args);
    } catch {
      // If the arguments cannot be parsed they cannot match anything
      // either; fall back to the raw values.
      return args;
    }
  }
}

/**
 * A gate that always says no.
 *
 * Used when there is no way to ask the user (for example an unattended
 * background worker). A destructive tool must never run without a human
 * decision, so the safe default is to refuse.
 */
export class DenyAllApprovalGate implements ApprovalGate {
  readonly source: ApprovalSource = 'fallback';

  constructor(private readonly audit: ApprovalAudit = noopApprovalAudit) {}

  async request(input: {
    approval: ApprovalRequest;
    requestId: string;
    fallback: () => Promise<boolean>;
  }): Promise<boolean> {
    this.audit.record({
      requestId: input.requestId,
      toolName: input.approval.toolName,
      decision: 'rejected',
      source: this.source,
      at: new Date().toISOString(),
    });
    return false;
  }
}

/**
 * What the server wants the client to ask the user.
 *
 * Deliberately provider-neutral: the MCP layer turns this into the
 * protocol's `elicitation/create` request.
 */
export interface ElicitationRequest {
  /** The question, in one sentence. */
  message: string;
  /** The short title of the prompt. */
  title: string;
  /** Extra detail about what will happen if the user says yes. */
  description: string;
}

/**
 * The minimal surface the elicitation gate needs from an MCP server.
 *
 * Narrowing it to this one method keeps `src/ai/` free of any MCP import:
 * the agent layer depends on the interface, the MCP layer provides the
 * implementation (`src/mcp/elicitation.ts`).
 */
export interface ElicitationCapable {
  elicitInput(request: ElicitationRequest): Promise<{
    action: 'accept' | 'decline' | 'cancel';
    content?: Record<string, unknown>;
  }>;
}

/** Thrown when the client did not answer the elicitation in time. */
export class ElicitationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Elicitation timed out after ${timeoutMs}ms`);
    this.name = 'ElicitationTimeoutError';
  }
}

/**
 * The protocol-native approval path.
 *
 * The server asks the *client* for a structured decision using
 * `elicitation/create`. The client answers with `accept`, `decline` or
 * `cancel`; only `accept` with `confirm: true` runs the tool.
 *
 * If the client cannot elicit (no `elicitation` capability, an older
 * client, or a client that hangs up), the gate falls back to the supplied
 * `fallback()` — which for the web path is the HTTP approval list.
 */
export class ElicitationApprovalGate implements ApprovalGate {
  readonly source: ApprovalSource = 'elicitation';

  constructor(
    private readonly server: ElicitationCapable,
    private readonly audit: ApprovalAudit = noopApprovalAudit,
    /** How long to wait for the client to answer before falling back. */
    private readonly timeoutMs = 60_000,
  ) {}

  async request(input: {
    approval: ApprovalRequest;
    requestId: string;
    fallback: () => Promise<boolean>;
  }): Promise<boolean> {
    const { approval, requestId } = input;

    let result: Awaited<ReturnType<ElicitationCapable['elicitInput']>>;
    try {
      result = await withTimeout(
        this.server.elicitInput({
          message: approval.message,
          title: approval.title,
          description:
            'Muca wants to run a consequential action. Set "confirm" to true to run it.',
        }),
        this.timeoutMs,
      );
    } catch (error) {
      const timedOut = error instanceof ElicitationTimeoutError;

      this.audit.record({
        requestId,
        toolName: approval.toolName,
        decision: timedOut ? 'timed_out' : 'rejected',
        source: this.source,
        at: new Date().toISOString(),
      });

      // The client could not be asked. Fall back to the caller's path.
      // In the MCP flow that path has no HTTP approvals, so the fallback
      // refuses and the tool does not run.
      const allowed = await input.fallback();

      this.audit.record({
        requestId,
        toolName: approval.toolName,
        decision: allowed ? 'approved' : 'rejected',
        source: 'fallback',
        at: new Date().toISOString(),
      });
      return allowed;
    }

    const accepted = result.action === 'accept';
    const confirmed =
      accepted &&
      (result.content?.confirm === true || result.content?.confirm === 'true');

    this.audit.record({
      requestId,
      toolName: approval.toolName,
      decision: accepted ? (confirmed ? 'approved' : 'rejected') : 'rejected',
      source: this.source,
      at: new Date().toISOString(),
    });

    return confirmed;
  }
}

/**
 * Races a promise against a timer. The timer is always cleared, so a
 * rejected elicitation never leaves a dangling handle keeping the process
 * alive.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ElicitationTimeoutError(timeoutMs));
    }, timeoutMs);
    // `unref` keeps a pending approval from holding the event loop open.
    timer.unref?.();

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
