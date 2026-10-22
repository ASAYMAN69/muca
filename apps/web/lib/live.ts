/**
 * The live client.
 *
 * One socket per session, speaking the protocol in
 * `AGENTS/WS_PROTOCOL.md` §1–§5.
 *
 * The rules this file exists to keep:
 *
 *   - **The browser only ever calls its own origin.** The socket URL is
 *     derived from `window.location`; there is no host, no port and no
 *     environment variable anywhere in this file.
 *   - **No frame is ever lost.** Frames are applied in sequence order. If a
 *     frame arrives out of order it is buffered until the hole in front of
 *     it is filled, and the client asks the server to replay the range it
 *     is missing.
 *   - **A dropped connection is not an error.** The client reconnects with
 *     a backoff, asks for everything it missed, and carries on.
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

/** One server frame. */
export interface LiveFrame {
  seq: number;
  sessionId: string;
  runId: string | null;
  ts: string;
  type: string;
  data: unknown;
}

/** The frames the client sends. */
export type ClientFrame =
  | { type: 'resume'; lastSeq: number }
  | { type: 'answer'; requestId: string; text: string }
  | {
      type: 'decide';
      requestId: string;
      decision: 'allow' | 'deny';
      remember?: boolean;
    }
  | { type: 'ping' };

/** The state of the connection, as the UI shows it. */
export type LiveStatus =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline';

export interface LiveClientOptions {
  /** The session this socket belongs to. */
  sessionId: string;
  /** Called for every frame, in sequence order. */
  onFrame: (frame: LiveFrame) => void;
  /** Called when the connection state changes. */
  onStatus?: (status: LiveStatus, detail?: string) => void;
  /**
   * Called when the server says frames are missing and cannot be
   * replayed. The app refetches the session over REST.
   */
  onGap?: (from: number, to: number, reason?: string) => void;
  /** The origin to connect to. Defaults to the page's own origin. */
  origin?: string;
  /** Injected for tests. Defaults to the browser's `WebSocket`. */
  createSocket?: (url: string) => SocketLike;
  /** How long to wait between heartbeats. */
  heartbeatMs?: number;
}

/** The slice of `WebSocket` this client uses. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    handler: (event: unknown) => void,
  ): void;
}

const MAX_BACKOFF_MS = 8_000;
const BASE_BACKOFF_MS = 500;
const MAX_ATTEMPTS = 6;

export class LiveClient {
  private readonly options: LiveClientOptions;
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private closed = false;
  private status: LiveStatus = 'idle';
  /** The highest sequence number with no hole in front of it. */
  private contiguousSeq = 0;
  /** Frames that arrived early, waiting for the hole in front of them. */
  private readonly buffer = new Map<number, LiveFrame>();
  /** The sequence we last asked the server to replay from. */
  private resumeRequestedFor: number | null = null;

  constructor(options: LiveClientOptions) {
    this.options = options;
  }

  /** The last sequence number the client has, contiguously. */
  get lastSeq(): number {
    return this.contiguousSeq;
  }

  /** The current connection state. */
  get currentStatus(): LiveStatus {
    return this.status;
  }

  /** Opens the socket. Safe to call more than once. */
  connect(): void {
    if (this.closed) return;
    if (this.socket) return;
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    this.openSocket();
  }

  /** Closes the socket and stops reconnecting. */
  close(): void {
    this.closed = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.close();
      } catch {
        // A socket that is already gone is not a problem.
      }
    }
    this.setStatus('idle');
  }

  /** Sends a frame. Returns false when the socket is not open. */
  send(frame: ClientFrame): boolean {
    if (!this.socket || this.status !== 'live') return false;
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Asks the server to replay everything after `lastSeq`. */
  resume(lastSeq = this.contiguousSeq): void {
    this.send({ type: 'resume', lastSeq });
  }

  /**
   * Asks for a range once.
   *
   * The server replays from the sequence the client names, so one request
   * per hole is enough: the frames that arrive fill it.
   */
  private requestResume(lastSeq: number): void {
    if (this.resumeRequestedFor === lastSeq) return;
    this.resumeRequestedFor = lastSeq;
    this.send({ type: 'resume', lastSeq });
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                          */
  /* ------------------------------------------------------------------ */

  private setStatus(status: LiveStatus, detail?: string): void {
    if (this.status === status && !detail) return;
    this.status = status;
    this.options.onStatus?.(status, detail);
  }

  private clearTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private url(): string | null {
    const origin =
      this.options.origin ??
      (typeof window === 'undefined' ? null : window.location.origin);
    if (!origin) return null;
    const url = new URL('/api/v1/ws', origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session', this.options.sessionId);
    if (this.contiguousSeq > 0) {
      url.searchParams.set('lastSeq', String(this.contiguousSeq));
    }
    return url.toString();
  }

  private openSocket(): void {
    const create =
      this.options.createSocket ??
      ((url: string) => new WebSocket(url) as unknown as SocketLike);

    const url = this.url();
    if (!url) {
      this.setStatus('offline', 'no origin to connect to');
      return;
    }

    let socket: SocketLike;
    try {
      socket = create(url);
    } catch (cause) {
      this.scheduleReconnect(cause instanceof Error ? cause.message : undefined);
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.setStatus('live');
      this.startHeartbeat();
    });

    socket.addEventListener('message', (event) => {
      this.receive(event);
    });

    socket.addEventListener('error', () => {
      // The close handler does the reconnecting; an error is only a hint.
    });

    socket.addEventListener('close', () => {
      if (this.socket === socket) this.socket = null;
      this.stopHeartbeat();
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private receive(event: unknown): void {
    const raw =
      typeof event === 'object' && event !== null && 'data' in event
        ? (event as { data: unknown }).data
        : event;
    if (typeof raw !== 'string') return;

    let frame: LiveFrame;
    try {
      frame = JSON.parse(raw) as LiveFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== 'string') return;

    if (frame.type === 'gap') {
      const data = (frame.data ?? {}) as { from?: number; to?: number; reason?: string };
      this.options.onGap?.(data.from ?? 0, data.to ?? 0, data.reason);
      return;
    }

    if (typeof frame.seq === 'number') {
      if (frame.seq <= this.contiguousSeq) {
        // A duplicate: the server replayed it after a resume.
        return;
      }
      if (frame.seq > this.contiguousSeq + 1) {
        // A hole in the sequence. Ask for the missing range, and keep the
        // frame that arrived early until the hole is filled.
        this.requestResume(this.contiguousSeq);
      }
      this.buffer.set(frame.seq, frame);
      this.drain();
      return;
    }

    // A frame without a sequence number (a `hello` in some builds).
    this.options.onFrame(frame);
  }

  /** Applies every buffered frame that is now in order. */
  private drain(): void {
    for (;;) {
      const next = this.buffer.get(this.contiguousSeq + 1);
      if (!next) break;
      this.buffer.delete(next.seq);
      this.contiguousSeq = next.seq;
      this.options.onFrame(next);
    }
    if (this.buffer.size === 0) {
      // The hole is filled: the next gap deserves its own request.
      this.resumeRequestedFor = null;
    }
  }

  private scheduleReconnect(detail?: string): void {
    this.clearTimers();
    if (this.attempts >= MAX_ATTEMPTS) {
      this.setStatus('offline', detail);
      return;
    }
    const delay = Math.min(
      BASE_BACKOFF_MS * 2 ** this.attempts,
      MAX_BACKOFF_MS,
    );
    // A little jitter, so a server restart does not get a thundering herd.
    const wait = delay * (0.75 + Math.random() * 0.5);
    this.attempts += 1;
    this.setStatus('reconnecting', detail);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed) return;
      this.openSocket();
    }, wait);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeatMs ?? 25_000;
    this.heartbeat = setInterval(() => {
      this.send({ type: 'ping' });
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
