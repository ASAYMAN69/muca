import { randomUUID } from 'node:crypto';

import type {
  ApprovalGate,
  ApprovalRequest,
  ApprovalSource,
} from '../ai/approval-gate.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { LiveEventType } from './frames.js';

/**
 * The live approval gate.
 *
 * This is the **new** path. The old HTTP path — the client sends back
 * the call id — stays exactly as it is, and the MCP path keeps its
 * elicitation gate. Neither is touched.
 *
 * The decision is made by the **server**, from the tool being called and
 * the user's own policies. The model never sees a policy and cannot
 * influence one: all it can do is ask for a tool, and the server decides
 * what happens to that request.
 */
export interface LiveGateHooks {
  /** The session the run belongs to. */
  sessionId: string;
  /** The run the gate belongs to. */
  runId: string;
  /** Emits a frame to the session. */
  emit(type: LiveEventType, data: unknown): void;
  /** Records the permission request, so the audit trail has it. */
  recordRequest(input: {
    requestId: string;
    toolName: string;
    title: string;
    arguments: Record<string, unknown>;
    policyId: string | null;
  }): void;
  /** Records the decision. */
  recordDecision(input: {
    requestId: string;
    status: 'allowed' | 'denied';
    policyId: string | null;
  }): void;
  /**
   * Waits for the user's decision.
   *
   * The run is parked while it waits. The promise settles when the client
   * sends a `decide` frame.
   */
  awaitDecision(requestId: string): Promise<'allow' | 'deny'>;
}

/** The source the live gate reports in the audit trail. */
export const LIVE_APPROVAL_SOURCE: ApprovalSource = 'policy';

/**
 * The gate the live path uses.
 *
 * It has three answers:
 *
 *   - **allow** — the policy says so, or the tool only reads. The tool
 *     runs and nobody is asked.
 *   - **deny** — a policy refuses. The tool does not run, and the user
 *     is told why.
 *   - **ask** — nobody has decided. The run parks and the user is asked.
 */
export class LivePolicyGate implements ApprovalGate {
  readonly source: ApprovalSource = LIVE_APPROVAL_SOURCE;

  constructor(
    private readonly engine: PolicyEngine,
    private readonly registry: ToolRegistry,
    private readonly hooks: LiveGateHooks,
  ) {}

  async request(input: {
    approval: ApprovalRequest;
    requestId: string;
    fallback: () => Promise<boolean>;
  }): Promise<boolean> {
    const { approval } = input;

    const tool = this.registry.get(approval.toolName);
    const writes = tool?.writes ?? true;

    const decision = this.engine.evaluate({
      sessionId: this.hooks.sessionId,
      toolName: approval.toolName,
      arguments: approval.arguments,
      writes,
    });

    if (decision.effect === 'allow') {
      // A policy allows it, or the tool only reads. Nobody is asked.
      return true;
    }

    // The request id the client sees. It is not the model's call id: the
    // client must not be able to confuse a tool call with a permission.
    const requestId = `req_${randomUUID()}`;

    const payload = {
      requestId,
      // The tool call this permission belongs to, so the client can show
      // the decision on the right row instead of guessing. It is
      // **correlation only**: the request id is what authorises the call,
      // and this id is never accepted as an authorisation token.
      toolCallId: input.requestId,
      tool: approval.toolName,
      title: tool?.title ?? approval.title,
      description: tool?.description ?? '',
      arguments: approval.arguments,
      reason: decision.reason,
      matchedPolicy: decision.matchedPolicy,
      // True when a policy has already answered: nobody is asked, and the
      // run must not park. The frame is still sent, so the user can see
      // what was refused and which policy refused it.
      autoResolved: decision.effect === 'deny',
    };

    this.hooks.emit('permission_requested', payload);
    this.hooks.recordRequest({
      requestId,
      toolName: approval.toolName,
      title: payload.title,
      arguments: approval.arguments,
      policyId: decision.policy?.id ?? null,
    });

    if (decision.effect === 'deny') {
      // A policy refuses. The tool does not run, and the user is told
      // which policy said no.
      this.hooks.emit('permission_resolved', {
        requestId,
        decision: 'deny',
        policyId: decision.matchedPolicy,
      });
      this.hooks.recordDecision({
        requestId,
        status: 'denied',
        policyId: decision.policy?.id ?? null,
      });
      return false;
    }

    // Nobody has decided yet: park the run and wait for the user.
    const userDecision = await this.hooks.awaitDecision(requestId);

    this.hooks.emit('permission_resolved', {
      requestId,
      decision: userDecision,
      policyId: decision.matchedPolicy,
    });
    this.hooks.recordDecision({
      requestId,
      status: userDecision === 'allow' ? 'allowed' : 'denied',
      policyId: decision.policy?.id ?? null,
    });

    return userDecision === 'allow';
  }
}
