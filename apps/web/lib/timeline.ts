/**
 * The run timeline model.
 *
 * The server sends an ordered list of `events`. A judge does not want to
 * read a transcript — they want to see a workflow: the request, the tool
 * calls, the evidence, the approval, the outcome.
 *
 * The rule this file exists to enforce: **one tool call is one row**. A
 * call that needs approval is *upgraded* into its approval row, and the
 * decision that follows resolves that same row. A judge must never see
 * two rows for one call, and must never see a "declined" row next to a
 * "waiting" row for the same call.
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
 * What the server told us about one tool call.
 *
 * The row for the call lives in `step`; everything else is the evidence
 * that decides which status the row ends up with.
 */
interface CallState {
  /** The single row for this tool call. */
  step: TimelineStep;
  /** The last approval decision the server recorded for this call. */
  decision?: boolean;
  /** The confirmation the server asked for, if it asked for one. */
  confirmation?: { message: string };
  /** True when the tool returned a result. */
  hasResult: boolean;
  /** The error the tool reported, if any. */
  error?: string;
}

/**
 * Builds the timeline from the event list.
 *
 * `text` events are folded into the outcome rather than shown as their own
 * steps: the assistant's prose belongs at the end of the run, not in the
 * middle of the mechanics.
 *
 * The status of a call is decided in a second pass, once every event has
 * been seen. That matters for approvals: the server records a decision
 * *before* it asks for confirmation, so the "was this declined?" question
 * can only be answered once we know whether the run is still waiting for
 * the user.
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
  /** call id -> what we know about that call. */
  const calls = new Map<string, CallState>();
  /** The call ids, in the order the server mentioned them. */
  const callOrder: string[] = [];
  /** The last call the server asked for confirmation for. */
  let lastConfirmationCallId: string | undefined;

  for (const [index, event] of input.events.entries()) {
    switch (event.type) {
      case 'text':
        // The assistant's prose is the outcome; handled below.
        break;

      case 'tool_call': {
        const destructive =
          input.destructiveTools?.has(event.name) === true;
        const step: TimelineStep = {
          id: `s-call-${event.id || index}`,
          kind: 'tool_call',
          status: 'running',
          title: titleForTool(event.name),
          toolName: event.name,
          arguments: formatArguments(event.arguments),
          destructive,
          callId: event.id,
        };
        steps.push(step);
        register(calls, callOrder, event.id, { step, hasResult: false });
        break;
      }

      case 'tool_result': {
        const call = calls.get(event.id);
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
        if (call) call.hasResult = true;
        break;
      }

      case 'confirmation_required': {
        const call = calls.get(event.id);
        if (call) {
          // The tool call row is upgraded into the approval row rather
          // than becoming a second row for the same call.
          call.confirmation = { message: event.message };
          call.step.kind = 'approval';
          call.step.callId = event.id;
          call.step.destructive = true;
          call.step.toolName = event.name || call.step.toolName;
          call.step.title = event.name
            ? titleForTool(event.name)
            : call.step.title;
          call.step.arguments = formatArguments(event.arguments);
        } else {
          // The server asked for confirmation for a call we never saw
          // (a truncated event list). Keep it visible on its own row.
          const step: TimelineStep = {
            id: `s-approval-${event.id || index}`,
            kind: 'approval',
            status: 'running',
            title: 'Approval required',
            summary: event.message,
            callId: event.id,
            toolName: event.name,
            arguments: formatArguments(event.arguments),
            destructive: true,
          };
          steps.push(step);
          register(calls, callOrder, event.id, {
            step,
            hasResult: false,
            confirmation: { message: event.message },
          });
        }
        lastConfirmationCallId = event.id;
        break;
      }

      case 'approval_decision': {
        const call = calls.get(event.id);
        if (call) {
          // The decision resolves the call's row. Which status it ends up
          // with depends on the rest of the run, so it is decided below.
          call.decision = event.approved;
        } else {
          // A decision for a call we never saw. Keep a row so the decision
          // is not lost.
          const step: TimelineStep = {
            id: `s-decision-${event.id || index}`,
            kind: 'approval',
            status: 'running',
            title: event.approved ? 'Approved' : 'Declined',
            callId: event.id,
            toolName: event.name,
          };
          steps.push(step);
          register(calls, callOrder, event.id, {
            step,
            hasResult: false,
            decision: event.approved,
          });
        }
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
        // The error belongs to the call that has not reported a result
        // yet: the tool failed.
        const open = lastUnresolved(calls, callOrder);
        if (open) open.error = event.message;
        break;
      }

      default:
        // The union is closed, so this is unreachable in practice.
        break;
    }
  }

  // The call the run is still waiting for. A parked run always names it;
  // if it does not, the last call the server asked about is the one.
  const awaitedCallId = input.awaitingConfirmation
    ? (input.pendingCall?.callId ?? lastConfirmationCallId)
    : undefined;

  for (const callId of callOrder) {
    resolve(calls.get(callId)!, callId === awaitedCallId);
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

/** Remembers a call, keeping the order the server mentioned it in. */
function register(
  calls: Map<string, CallState>,
  callOrder: string[],
  callId: string,
  state: CallState,
): void {
  if (!calls.has(callId)) callOrder.push(callId);
  calls.set(callId, state);
}

/** The most recent call that has not reported a result yet. */
function lastUnresolved(
  calls: Map<string, CallState>,
  callOrder: string[],
): CallState | undefined {
  for (let index = callOrder.length - 1; index >= 0; index -= 1) {
    const call = calls.get(callOrder[index]);
    if (call && !call.hasResult) return call;
  }
  return undefined;
}

/**
 * Decides the final status of one call's row.
 *
 * The rules, in the order they apply:
 *
 *   - the run is waiting for this call: `blocked` (waiting). The server
 *     records a decision *before* it asks, and that decision is not a
 *     rejection — the user has not answered yet.
 *   - the call was approved: `failed` if the tool reported an error,
 *     otherwise `success` once the result arrives.
 *   - the call was declined: `rejected` (declined).
 *   - no decision and no result: `failed`.
 */
function resolve(call: CallState, awaited: boolean): void {
  const step = call.step;
  // A call is an approval row when the server asked for confirmation *or*
  // when it recorded a decision for it.
  const isApproval =
    call.confirmation !== undefined || call.decision !== undefined;

  if (!isApproval) {
    // A plain tool call: the result is the evidence.
    if (call.error) {
      step.status = 'failed';
      step.summary = call.error;
    } else if (call.hasResult) {
      step.status = 'success';
    } else {
      step.status = 'failed';
      step.summary = 'The tool did not return a result.';
    }
    return;
  }

  // An approval row.
  if (awaited) {
    step.status = 'blocked';
    step.summary = call.confirmation?.message ?? step.summary;
    return;
  }

  if (call.decision === true) {
    if (call.error) {
      step.status = 'failed';
      step.summary = call.error;
    } else if (call.hasResult) {
      step.status = 'success';
      step.summary = 'Approved by you. The tool ran.';
    } else {
      step.status = 'running';
      step.summary = 'Approved by you. Running it now.';
    }
    return;
  }

  if (call.decision === false) {
    step.status = 'rejected';
    step.summary = 'You declined this action. Nothing was run.';
    return;
  }

  step.status = call.hasResult ? 'success' : 'failed';
  step.summary = call.hasResult
    ? 'Approved by you. The tool ran.'
    : 'The tool did not return a result.';
}
