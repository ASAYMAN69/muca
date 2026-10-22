/**
 * The live run.
 *
 * A pure reducer that turns the frames of a live protocol (§3) into the
 * state of one run. The app renders that state with the same timeline it
 * uses for a request/response run, so a live run and a replayed run look
 * and behave the same.
 *
 * Nothing here touches the network or React, so every rule is testable.
 */

import type { AgentEvent, PendingCall } from './api';
import type { LiveFrame } from './live';

export type LiveRunStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error';

/** A question the agent asked and is waiting on. */
export interface LiveClarification {
  id: string;
  question: string;
  options?: string[];
  answer?: string;
}

export interface LiveRunState {
  /** The run id, when the server named it. */
  runId?: string;
  /** The provider and model that answered, when the server said. */
  provider?: string;
  model?: string;
  /** Every event of the run, in order. */
  events: AgentEvent[];
  /** The answer, as it streams in. */
  text: string;
  /** The model's reasoning, as it streams in. */
  thinking: string;
  /** True while the thinking row is live. */
  thinkingActive: boolean;
  /** The permission the run is parked on. */
  pending: PendingCall | null;
  /** The question the run is parked on. */
  clarification: LiveClarification | null;
  /** True while the run waits for the user. */
  awaitingConfirmation: boolean;
  /**
   * The tool call that is running and has not answered yet.
   *
   * A permission request names the *request*, not the call, so this is
   * how the two are tied together.
   */
  openCallId?: string;
  /** Permission request id -> the tool call it belongs to. */
  requests: Record<string, string>;
  /** The outcome label the server reported. */
  outcome?: string;
  toolCallCount: number;
  approvalCount: number;
  durationMs?: number;
  error?: string;
  status: LiveRunStatus;
}

export function emptyRun(runId?: string): LiveRunState {
  return {
    runId,
    events: [],
    text: '',
    thinking: '',
    thinkingActive: false,
    pending: null,
    clarification: null,
    awaitingConfirmation: false,
    openCallId: undefined,
    requests: {},
    outcome: undefined,
    toolCallCount: 0,
    approvalCount: 0,
    durationMs: undefined,
    error: undefined,
    status: 'idle',
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Applies one frame to a run.
 *
 * The frame's `data` is read defensively: a field the server did not send
 * is simply missing, never a crash.
 */
export function applyFrame(state: LiveRunState, frame: LiveFrame): LiveRunState {
  const data = asRecord(frame.data);

  switch (frame.type) {
    case 'run_started': {
      const next = emptyRun(frame.runId ?? undefined);
      next.provider = asString(data.provider) || undefined;
      next.model = asString(data.model) || undefined;
      next.status = 'running';
      return next;
    }

    case 'thinking_delta': {
      const text = asString(data.text);
      if (!text) return state;
      return {
        ...state,
        thinking: state.thinking + text,
        thinkingActive: true,
        status: 'running',
      };
    }

    case 'message_delta': {
      const text = asString(data.text);
      if (!text) return state;
      return {
        ...state,
        text: state.text + text,
        thinkingActive: false,
        status: 'running',
      };
    }

    case 'message_complete': {
      const text = asString(data.text);
      return {
        ...state,
        text: text || state.text,
        thinkingActive: false,
        status: state.awaitingConfirmation ? 'waiting' : state.status,
      };
    }

    case 'tool_call_started': {
      const callId = asString(data.callId);
      const name = asString(data.name);
      const args = asRecord(data.arguments);
      return {
        ...state,
        thinkingActive: false,
        openCallId: callId,
        events: [
          ...state.events,
          { type: 'tool_call', id: callId, name, arguments: args },
        ],
        status: 'running',
      };
    }

    case 'tool_call_completed': {
      const callId = asString(data.callId);
      const name = asString(data.name);
      const summary = asString(data.summary);
      const ok = data.ok !== false;
      const events: AgentEvent[] = [
        ...state.events,
        {
          type: 'tool_result',
          id: callId,
          name,
          summary,
          data: data.data ?? null,
        },
      ];
      if (!ok) {
        events.push({
          type: 'error',
          message: summary || `${name} failed.`,
        });
      }
      return {
        ...state,
        events,
        openCallId:
          state.openCallId === callId ? undefined : state.openCallId,
        status: 'running',
      };
    }

    case 'permission_requested': {
      const requestId = asString(data.requestId);
      const tool = asString(data.tool);
      const args = asRecord(data.arguments);
      const reason = asString(data.reason);
      const title = asString(data.title) || tool;
      const matchedPolicy =
        typeof data.matchedPolicy === 'string' ? data.matchedPolicy : null;
      // A policy already answered: the tool was refused, nobody is asked,
      // and the run continues. Show what was refused and why, with no
      // buttons — the decision is made.
      const autoResolved = data.autoResolved === true;
      // The server names the tool call the permission belongs to. It is
      // correlation only, never an authorisation token, so the client uses
      // it to find the right row and nothing more.
      const callId = asString(data.toolCallId) || state.openCallId || requestId;
      const pending: PendingCall = {
        callId,
        requestId,
        name: tool,
        title,
        description: asString(data.description) || undefined,
        arguments: args,
        message: reason || title,
        reason: reason || undefined,
        matchedPolicy,
      };
      if (autoResolved) {
        return {
          ...state,
          thinkingActive: false,
          events: [
            ...state.events,
            {
              type: 'confirmation_required',
              id: callId,
              name: tool,
              arguments: args,
              message: reason || title,
              title,
              description: asString(data.description) || undefined,
              reason: reason || undefined,
              matchedPolicy,
            },
            {
              type: 'approval_decision',
              id: callId,
              name: tool,
              approved: false,
              source: 'http',
            },
          ],
          pending: null,
          awaitingConfirmation: false,
          status: 'running',
        };
      }

      return {
        ...state,
        thinkingActive: false,
        requests: { ...state.requests, [requestId]: callId },
        events: [
          ...state.events,
          {
            type: 'confirmation_required',
            id: callId,
            name: tool,
            arguments: args,
            message: reason || title,
            title,
            description: asString(data.description) || undefined,
            reason: reason || undefined,
            matchedPolicy,
          },
        ],
        pending,
        awaitingConfirmation: true,
        status: 'waiting',
      };
    }

    case 'permission_resolved': {
      const requestId = asString(data.requestId);
      const decision = asString(data.decision);
      const approved = decision === 'allow';
      const callId = state.requests[requestId] ?? requestId;
      const name =
        state.pending &&
        (state.pending.requestId === requestId ||
          state.pending.callId === requestId)
          ? state.pending.name
          : '';
      const events: AgentEvent[] = [
        ...state.events,
        {
          type: 'approval_decision',
          id: callId,
          name,
          approved,
          source: 'http',
        },
      ];
      const stillPending =
        state.pending &&
        (state.pending.requestId === requestId ||
          state.pending.callId === requestId);
      return {
        ...state,
        events,
        pending: stillPending ? null : state.pending,
        awaitingConfirmation: stillPending ? false : state.awaitingConfirmation,
        approvalCount: state.approvalCount + 1,
        status: stillPending ? 'running' : state.status,
      };
    }

    case 'clarification_requested': {
      const id = asString(data.requestId);
      const question = asString(data.question);
      const options = Array.isArray(data.options)
        ? data.options.filter((option): option is string => typeof option === 'string')
        : undefined;
      return {
        ...state,
        thinkingActive: false,
        events: [
          ...state.events,
          { type: 'clarification', id, question, options },
        ],
        clarification: { id, question, options },
        awaitingConfirmation: true,
        status: 'waiting',
      };
    }

    case 'clarification_answered': {
      const id = asString(data.requestId);
      const answer = asString(data.answer);
      return {
        ...state,
        events: [...state.events, { type: 'clarification_answered', id, answer }],
        clarification:
          state.clarification && state.clarification.id === id
            ? { ...state.clarification, answer }
            : state.clarification,
        awaitingConfirmation: false,
        status: 'running',
      };
    }

    case 'run_finished': {
      return {
        ...state,
        outcome: asString(data.outcome) || state.outcome,
        toolCallCount:
          typeof data.toolCallCount === 'number'
            ? data.toolCallCount
            : state.toolCallCount,
        approvalCount:
          typeof data.approvalCount === 'number'
            ? data.approvalCount
            : state.approvalCount,
        durationMs:
          typeof data.durationMs === 'number' ? data.durationMs : state.durationMs,
        pending: null,
        clarification: null,
        awaitingConfirmation: false,
        thinkingActive: false,
        status: 'done',
      };
    }

    case 'run_error': {
      const message = asString(data.message) || 'The run failed.';
      return {
        ...state,
        error: message,
        events: [...state.events, { type: 'error', message }],
        status: 'error',
      };
    }

    default:
      return state;
  }
}
