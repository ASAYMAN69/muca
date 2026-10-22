import type { EventStore } from '../store/events.js';
import { LiveSession } from './session.js';
import { eventFrame, type LiveEventFrame, type LiveEventType } from './frames.js';

/** A range of frames the server cannot give back. */
export interface FrameGap {
  from: number;
  to: number;
  reason: string;
}

/** What a reconnect gets back. */
export interface ReplayResult {
  /** The frames, in sequence order. */
  frames: LiveEventFrame[];
  /** The ranges that are missing and cannot be replayed. */
  gaps: FrameGap[];
}

/**
 * The live hub.
 *
 * It owns the sessions, their sequence counters and their ring buffers,
 * and it is the one place that knows how to put a client's missed frames
 * back together.
 *
 * The rule the whole protocol rests on: **the server must never silently
 * skip frames.** Either the client receives every sequence number, or it
 * is told about the gap.
 */
export class LiveHub {
  private readonly sessions = new Map<string, LiveSession>();

  /** The session that was last connected to. */
  private lastActiveSessionId: string | null = null;

  /**
   * @param events The durable event log. Optional: without it the hub
   *   can only replay what the ring buffer still holds.
   */
  constructor(private readonly events?: EventStore) {}

  /**
   * The session, created on first use.
   *
   * The sequence counter continues where the database left off, so a
   * restart never reuses a number.
   */
  session(sessionId: string): LiveSession {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;

    const stored = this.events?.maxSeq(sessionId) ?? 0;
    const session = new LiveSession(sessionId, stored + 1);
    this.sessions.set(sessionId, session);
    return session;
  }

  /** True when the session has been seen. */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Publishes a frame to a session. */
  publish(
    sessionId: string,
    type: LiveEventType,
    data: unknown,
    runId?: string | null,
  ): LiveEventFrame {
    return this.session(sessionId).publish(type, data, runId);
  }

  /** Records that a client is watching a session. */
  markActive(sessionId: string): void {
    this.lastActiveSessionId = sessionId;
  }

  /**
   * The session an unassociated run should be streamed to.
   *
   * A run that does not name its session — the plain REST path — is
   * streamed to the session that was last connected, so the browser sees
   * the run live. It is `null` when no client is watching.
   */
  get activeSessionId(): string | null {
    return this.lastActiveSessionId;
  }

  /** The sessions that have a socket attached. */
  activeSessionIds(): string[] {
    return [...this.sessions.values()]
      .filter((session) => session.subscriberCount > 0)
      .map((session) => session.id);
  }

  /**
   * The frames a client missed.
   *
   * The frames are collected from the two places they can be: the
   * in-memory ring buffer (the live ones, which may not be in the
   * database yet) and the durable log (the ones from finished runs).
   *
   * Whatever cannot be found is reported as a gap. There is no third
   * possibility: a frame is either delivered or reported missing.
   */
  replay(sessionId: string, lastSeq: number): ReplayResult {
    const session = this.session(sessionId);
    const storedMax = this.events?.maxSeq(sessionId) ?? 0;
    const target = Math.max(session.lastSeq, storedMax);

    // The client is ahead of the server: the server lost frames the
    // client has. It cannot give them back.
    if (lastSeq > target) {
      return {
        frames: [],
        gaps: [{ from: target + 1, to: lastSeq, reason: 'too old' }],
      };
    }

    const bySeq = new Map<number, LiveEventFrame>();

    for (const event of this.events?.readFrom(sessionId, lastSeq + 1) ?? []) {
      bySeq.set(
        event.seq,
        eventFrame({
          seq: event.seq,
          sessionId: event.sessionId,
          runId: event.runId,
          type: event.type as LiveEventType,
          data: event.data,
          ts: event.createdAt,
        }),
      );
    }

    for (const frame of session.framesSince(lastSeq)) {
      bySeq.set(frame.seq, frame);
    }

    const frames = [...bySeq.values()]
      .filter((frame) => frame.seq > lastSeq && frame.seq <= target)
      .sort((a, b) => a.seq - b.seq);

    return {
      frames,
      gaps: findGaps(lastSeq + 1, target, frames.map((f) => f.seq)),
    };
  }
}

/**
 * The sequence numbers that are missing from a range.
 *
 * Consecutive missing numbers are grouped into one gap, so a client is
 * told about a hole rather than about every frame in it.
 */
export function findGaps(
  from: number,
  to: number,
  present: number[],
): FrameGap[] {
  if (to < from) return [];

  const have = new Set(present);
  const gaps: FrameGap[] = [];
  let start: number | null = null;

  for (let seq = from; seq <= to; seq += 1) {
    if (have.has(seq)) {
      if (start !== null) {
        gaps.push({ from: start, to: seq - 1, reason: 'too old' });
        start = null;
      }
      continue;
    }
    if (start === null) start = seq;
  }

  if (start !== null) {
    gaps.push({ from: start, to, reason: 'too old' });
  }

  return gaps;
}
