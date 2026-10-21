/**
 * The run timeline model.
 *
 * The server sends an ordered list of `events`. A judge does not want to
 * read a transcript — they want to see a workflow: the request, the tool
 * calls, the evidence, the approval, the outcome.
 *
 * This module turns the event list into that structure. It is pure: no
 * React, no fetching, so the shape can be reasoned about on its own.
 */

import type { AgentEvent, PendingCall } from './api';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'blocked'
  | 'rejected';

export type StepKind =
  | 'request'
  | 'tool_call'
  | 'evidence'
  | 'approval'
  | 'outcome'
  | 'error';

export interface TimelineStep {
  id: string;
  kind: StepKind;
  status: StepStatus;
  title: string;
  /** One line describing what happened. */
  summary?: string;
  /** The tool name, for tool steps. */
  toolName?: string;
  /** The formatted arguments, for tool call steps. */
  arguments?: Array<{ key: string; value: string }>;
  /** The raw result data, for evidence steps. */
  data?: unknown;
  /** The result summary, for evidence steps. */
  resultSummary?: string;
  /** The call id, for approval steps. */
  callId?: string;
  /** True when the tool is destructive. */
  destructive?: boolean;
}

export interface Timeline {
  steps: TimelineStep[];
  /** The final assistant text. */
  outcome?: string;
  /** The approval the run is blocked on. */
  pending?: PendingCall | null;
  /** The run id, when the backend reported one. */
  runId?: string;
  /** True when the run is waiting for the user. */
  awaitingConfirmation: boolean;
  /** The events that were not understood, kept for the raw view. */
  unknownEvents: unknown[];
}

/** Formats an argument value for display. */
export function formatArgument(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Turns an argument object into readable key/value rows. */
export function formatArguments(
  args: Record<string, unknown> | undefined,
): Array<{ key: string; value: string }> {
  if (!args || typeof args !== 'object') return [];
  return Object.entries(args).map(([key, value]) => ({
    key,
    value: formatArgument(value),
  }));
}

/** A human title for a tool name. */
export function titleForTool(name: string): string {
  return name
    .split(/[._]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Builds the timeline from the event list.
 *
 * `text` events are folded into the outcome rather than shown as their own
 * steps: the assistant's prose belongs at the end of the run, not in the
 * middle of the mechanics.
 */
export function buildTimeline(input: {
  events: AgentEvent[];
  text?: string;
  pendingCall?: PendingCall | null;
  awaitingConfirmation?: boolean;
  runId?: string;
  destructiveTools?: Set<string>;
  /** The events the client did not understand, kept for the raw view. */
  unknownEvents?: unknown[];
}): Timeline {
  const steps: TimelineStep[] = [];
  const unknownEvents: unknown[] = [...(input.unknownEvents ?? [])];
  /** tool call id -> the step that is waiting for its result. */
  const pendingCalls = new Map<string, TimelineStep>();
  /** call id -> the step that carries the approval for that call. */
  const approvalSteps = new Map<string, TimelineStep>();

  for (const [index, event] of input.events.entries()) {
    switch (event.type) {
      case 'text':
        // The assistant's prose is the outcome; handled below.
        break;

      case 'tool_call': {
        const destructive =
          event.arguments && typeof event.arguments === 'object'
            ? input.destructiveTools?.has(event.name) === true
            : false;
        const step: TimelineStep = {
          id: `s-call-${event.id || index}`,
          kind: 'tool_call',
          status: 'running',
          title: titleForTool(event.name),
          toolName: event.name,
          arguments: formatArguments(event.arguments),
          destructive,
        };
        steps.push(step);
        pendingCalls.set(event.id, step);
        break;
      }

      case 'tool_result': {
        const call = pendingCalls.get(event.id);
        const approval = approvalSteps.get(event.id);
        const step: TimelineStep = {
          id: `s-evidence-${event.id || index}`,
          kind: 'evidence',
          status: 'success',
          title: `${titleForTool(event.name)} result`,
          toolName: event.name,
          resultSummary: event.summary,
          data: event.data,
        };
        steps.push(step);
        if (call) {
          call.status = 'success';
          pendingCalls.delete(event.id);
        }
        if (approval) {
          // The approved call ran: the approval is resolved.
          approval.status = 'success';
          approval.summary = 'Approved by you. The tool ran.';
          approvalSteps.delete(event.id);
        }
        break;
      }

      case 'confirmation_required': {
        // The tool call step already exists. Upgrade it into the approval
        // step rather than adding a second row for the same call.
        const call = pendingCalls.get(event.id);
        const step: TimelineStep = {
          id: `s-approval-${event.id || index}`,
          kind: 'approval',
          status: 'blocked',
          title: 'Approval required',
          summary: event.message,
          callId: event.id,
          toolName: event.name,
          arguments: formatArguments(event.arguments),
          destructive: true,
        };
        if (call) {
          // Fold the call step into the approval step.
          call.kind = 'approval';
          call.status = 'blocked';
          call.title = event.name ? titleForTool(event.name) : call.title;
          call.summary = event.message;
          call.callId = event.id;
          call.arguments = formatArguments(event.arguments);
          call.destructive = true;
          pendingCalls.delete(event.id);
          approvalSteps.set(event.id, call);
        } else {
          steps.push(step);
          approvalSteps.set(event.id, step);
        }
        break;
      }

      case 'approval_decision': {
        // The approval step already exists for this call. Update it in
        // place rather than adding a second row for the same call.
        const approval = approvalSteps.get(event.id);
        if (approval) {
          approval.status = event.approved ? 'success' : 'rejected';
          approval.summary = event.approved
            ? 'Approved by you. The tool ran.'
            : 'You declined this action. Nothing was run.';
          approvalSteps.delete(event.id);
          break;
        }

        // The tool call step already exists. Fold the decision into it.
        const call = pendingCalls.get(event.id);
        if (call) {
          call.kind = 'approval';
          call.status = event.approved ? 'running' : 'rejected';
          call.title = event.name ? titleForTool(event.name) : call.title;
          call.summary = event.approved
            ? 'Approved by you. Running it now.'
            : 'You declined this action. Nothing was run.';
          call.callId = event.id;
          call.destructive = true;
          pendingCalls.delete(event.id);
          break;
        }

        const step: TimelineStep = {
          id: `s-decision-${event.id || index}`,
          kind: 'approval',
          status: event.approved ? 'success' : 'rejected',
          title: event.approved ? 'Approved' : 'Declined',
          summary: `${titleForTool(event.name)} — ${
            event.approved ? 'approved by you' : 'declined by you'
          }`,
          callId: event.id,
          toolName: event.name,
        };
        steps.push(step);
        break;
      }

      case 'error': {
        const step: TimelineStep = {
          id: `s-error-${index}`,
          kind: 'error',
          status: 'failed',
          title: 'Error',
          summary: event.message,
        };
        steps.push(step);
        break;
      }

      default:
        // The union is closed, so this is unreachable in practice.
        break;
    }
  }

  // A tool call with no result never ran: it was blocked or it failed.
  for (const call of pendingCalls.values()) {
    if (call.status === 'running') {
      call.status = 'failed';
      call.summary = 'The tool did not return a result.';
    }
  }

  const outcome = input.text?.trim() ? input.text : undefined;

  return {
    steps,
    outcome,
    pending: input.pendingCall ?? null,
    runId: input.runId,
    awaitingConfirmation: input.awaitingConfirmation === true,
    unknownEvents,
  };
}
