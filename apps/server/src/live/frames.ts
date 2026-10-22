/**
 * The live protocol's frames.
 *
 * Every server→client frame is one JSON object with the same envelope
 * (`AGENTS/WS_PROTOCOL.md` §2). The **event** frames carry a sequence
 * number; the **control** frames — `hello`, `pong`, `gap`, `replayed` —
 * carry `null`, because they are not part of the session's event
 * sequence and must not consume a number.
 *
 * A client that tracked control frames in its sequence would lose the
 * event that shares the number, so the distinction matters.
 */

/** The frames the server sends. */
export type LiveFrameType =
  | 'hello'
  | 'run_started'
  | 'thinking_delta'
  | 'message_delta'
  | 'message_complete'
  | 'tool_call_started'
  | 'tool_call_completed'
  | 'permission_requested'
  | 'permission_resolved'
  | 'clarification_requested'
  | 'clarification_answered'
  | 'run_finished'
  | 'run_error'
  | 'gap'
  | 'replayed'
  | 'pong';

/** The frames that are part of the session's event sequence. */
export type LiveEventType = Exclude<LiveFrameType, 'hello' | 'pong' | 'gap' | 'replayed'>;

/** One event frame. It has a sequence number. */
export interface LiveEventFrame {
  seq: number;
  sessionId: string;
  runId: string | null;
  ts: string;
  type: LiveEventType;
  data: unknown;
}

/** One control frame. It has no sequence number. */
export interface LiveControlFrame {
  seq: null;
  sessionId: string;
  runId: string | null;
  ts: string;
  type: 'hello' | 'pong' | 'gap' | 'replayed';
  data: unknown;
}

/** Any frame the server sends. */
export type LiveFrame = LiveEventFrame | LiveControlFrame;

/** True when the frame is part of the event sequence. */
export function isEventFrame(frame: LiveFrame): frame is LiveEventFrame {
  return frame.seq !== null;
}

/** Builds an event frame. */
export function eventFrame(input: {
  seq: number;
  sessionId: string;
  runId?: string | null;
  type: LiveEventType;
  data: unknown;
  ts?: string;
}): LiveEventFrame {
  return {
    seq: input.seq,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    ts: input.ts ?? new Date().toISOString(),
    type: input.type,
    data: input.data,
  };
}

/** Builds a control frame. */
export function controlFrame(input: {
  sessionId: string;
  runId?: string | null;
  type: 'hello' | 'pong' | 'gap' | 'replayed';
  data: unknown;
  ts?: string;
}): LiveControlFrame {
  return {
    seq: null,
    sessionId: input.sessionId,
    runId: input.runId ?? null,
    ts: input.ts ?? new Date().toISOString(),
    type: input.type,
    data: input.data,
  };
}
