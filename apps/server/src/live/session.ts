import { eventFrame, type LiveEventFrame, type LiveEventType } from './frames.js';

/**
 * How many frames of a session are kept in memory.
 *
 * The ring buffer is the first place a reconnect looks for the frames it
 * missed. When it no longer holds them, the server reads them from
 * SQLite; when SQLite does not have them either, the server tells the
 * client about the gap.
 */
export const RING_BUFFER_SIZE = 2000;

/**
 * One live session.
 *
 * The session owns the sequence counter and the ring buffer. Both are
 * per session: two sessions never share a number.
 */
export class LiveSession {
  readonly id: string;

  /** The next sequence number to hand out. */
  private next: number;

  /** The last frames, newest last. */
  private readonly buffer: LiveEventFrame[] = [];

  /** The sockets that want this session's frames. */
  private readonly subscribers = new Set<(frame: LiveEventFrame) => void>();

  /**
   * @param id The session id.
   * @param firstSeq The first sequence number to hand out. It is
   *   `max(stored sequence) + 1`, so a restart never reuses a number.
   */
  constructor(id: string, firstSeq = 1) {
    this.id = id;
    this.next = Math.max(1, firstSeq);
  }

  /** The highest sequence number handed out so far. */
  get lastSeq(): number {
    return this.next - 1;
  }

  /** The sequence number the next frame will have. */
  get nextSeq(): number {
    return this.next;
  }

  /**
   * Publishes a frame.
   *
   * The frame is given the next sequence number, put in the ring buffer
   * and handed to every subscriber.
   */
  publish(type: LiveEventType, data: unknown, runId?: string | null): LiveEventFrame {
    const frame = eventFrame({
      seq: this.next,
      sessionId: this.id,
      runId: runId ?? null,
      type,
      data,
    });
    this.next += 1;

    this.buffer.push(frame);
    // The buffer is bounded: the oldest frames are dropped first.
    while (this.buffer.length > RING_BUFFER_SIZE) {
      this.buffer.shift();
    }

    for (const subscriber of this.subscribers) {
      try {
        subscriber(frame);
      } catch {
        // A subscriber that throws must not stop the others.
      }
    }

    return frame;
  }

  /** Subscribes to the session's frames. Returns the unsubscribe. */
  subscribe(subscriber: (frame: LiveEventFrame) => void): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /**
   * The buffered frames after a sequence number, oldest first.
   *
   * A frame that is still in the buffer is *live*: it may not be in the
   * database yet, because the database is only written when the run
   * finishes.
   */
  framesSince(seq: number): LiveEventFrame[] {
    return this.buffer.filter((frame) => frame.seq > seq);
  }

  /** The oldest sequence number still in the buffer. */
  get oldestBufferedSeq(): number | null {
    return this.buffer.length > 0 ? this.buffer[0]!.seq : null;
  }

  /** How many sockets are listening. */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
