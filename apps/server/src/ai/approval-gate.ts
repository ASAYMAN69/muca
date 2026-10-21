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

/** The two ways an approval can be obtained. */
export type ApprovalSource = 'elicitation' | 'http' | 'fallback';

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
 * A call id can be approved in two ways:
 *
 *   - by **exact call id** — the id the server handed out in `pendingCall`;
 *   - by **tool name** — the server remembers which tool a parked call id
 *     referred to, so the approval still lands when the model asks for the
 *     same tool again with a fresh call id.
 *
 * When the call is not approved, nobody has decided yet: the gate
 * *defers*, and the run parks with a `pendingCall` for the UI.
 */
export class HttpApprovalGate implements DeferrableApprovalGate {
  readonly source: ApprovalSource = 'http';

  /** The call ids that were approved outright. */
  private readonly approvedCallIds: ReadonlySet<string>;
  /** The tool names that were approved. Consumed once each. */
  private readonly approvedToolNames: Set<string>;
  /** The requests that are still waiting for a decision. */
  private readonly pending = new Set<string>();

  constructor(
    approvedCallIds: Iterable<string> = [],
    approvedToolNames: Iterable<string> = [],
    private readonly audit: ApprovalAudit = noopApprovalAudit,
  ) {
    this.approvedCallIds = new Set(approvedCallIds);
    this.approvedToolNames = new Set(approvedToolNames);
  }

  async request(input: {
    approval: ApprovalRequest;
    requestId: string;
    fallback: () => Promise<boolean>;
  }): Promise<boolean> {
    const { approval, requestId } = input;

    let approved = this.approvedCallIds.has(requestId);

    // A tool-name approval is consumed by the first matching call, so one
    // approval can never authorise two different actions.
    if (!approved && this.approvedToolNames.has(approval.toolName)) {
      this.approvedToolNames.delete(approval.toolName);
      approved = true;
    }

    if (approved) {
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

      // The client could not be asked. Fall back to the HTTP path.
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
