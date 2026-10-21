/**
 * The pending-approval registry.
 *
 * The web client is a plain browser page: it cannot receive an
 * elicitation request, so the server *parks* the run and hands the client
 * a `pendingCall` (a call id plus the arguments). The user clicks
 * *Approve* and the next request carries that call id back.
 *
 * The catch is that the model produces a **new** call id on the next
 * request, so matching on the call id alone would never approve anything.
 * This registry remembers which tool each parked call referred to, and
 * the HTTP gate can then approve the *next* call to that same tool.
 *
 * The registry is small, in-memory and bounded. It lives for the length
 * of a browser session, which is exactly as long as the approval is
 * meaningful.
 */

/** How many parked approvals are remembered at once. */
export const MAX_PENDING_APPROVALS = 50;

export interface PendingApproval {
  /** The call id the server handed to the client. */
  callId: string;
  /** The tool the call was for. */
  toolName: string;
  /** The arguments the call would have used. */
  arguments: Record<string, unknown>;
  /** When it was parked. */
  at: string;
}

export class PendingApprovalRegistry {
  private readonly byCallId = new Map<string, PendingApproval>();
  /** The tool name -> the most recent parked call for that tool. */
  private readonly byTool = new Map<string, PendingApproval>();

  /** Records a parked approval. */
  add(approval: PendingApproval): void {
    this.byCallId.set(approval.callId, approval);
    this.byTool.set(approval.toolName, approval);

    // Keep the registry bounded: the oldest entries are dropped first.
    while (this.byCallId.size > MAX_PENDING_APPROVALS) {
      const oldest = this.byCallId.keys().next();
      if (oldest.done) break;
      const dropped = this.byCallId.get(oldest.value);
      this.byCallId.delete(oldest.value);
      if (dropped && this.byTool.get(dropped.toolName)?.callId === dropped.callId) {
        this.byTool.delete(dropped.toolName);
      }
    }
  }

  /** The parked approval for a call id, if any. */
  get(callId: string): PendingApproval | undefined {
    return this.byCallId.get(callId);
  }

  /** The most recent parked approval for a tool, if any. */
  latestForTool(toolName: string): PendingApproval | undefined {
    return this.byTool.get(toolName);
  }

  /** Removes a parked approval (it was approved or abandoned). */
  remove(callId: string): void {
    const approval = this.byCallId.get(callId);
    this.byCallId.delete(callId);
    if (approval && this.byTool.get(approval.toolName)?.callId === callId) {
      this.byTool.delete(approval.toolName);
    }
  }

  /** Clears every parked approval. */
  clear(): void {
    this.byCallId.clear();
    this.byTool.clear();
  }

  /** The number of parked approvals. */
  get size(): number {
    return this.byCallId.size;
  }
}
