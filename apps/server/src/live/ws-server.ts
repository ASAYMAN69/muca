import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';

import { controlFrame, type LiveFrame } from './frames.js';
import type { LiveHub } from './hub.js';

/**
 * The WebSocket endpoint.
 *
 * It is attached to the **existing** Express server, on the **existing**
 * port, at `/api/v1/ws`. There is no second listener and no proxy: the
 * browser opens a socket to the same origin it loaded the app from.
 *
 * The socket needs no authentication and reads no cookie and no header
 * to identify the client: the session is in the query string, and any
 * origin is accepted, exactly like the rest of the app.
 */
export interface LiveSocketOptions {
  hub: LiveHub;
  /** The path the socket is served at. */
  path?: string;
  /** The user's decision on a permission. */
  onDecide?: (input: {
    sessionId: string;
    requestId: string;
    decision: 'allow' | 'deny';
    remember: boolean;
  }) => Promise<void> | void;
  /** The user's answer to a question. */
  onAnswer?: (input: {
    sessionId: string;
    requestId: string;
    text: string;
  }) => Promise<void> | void;
}

export class LiveSocketServer {
  private readonly wss: WebSocketServer;
  private readonly options: LiveSocketOptions;
  private readonly path: string;

  constructor(options: LiveSocketOptions) {
    this.options = options;
    this.path = options.path ?? '/api/v1/ws';
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Handles the HTTP upgrade.
   *
   * The socket is served on the same server as everything else, so there
   * is no new port and no new listener.
   */
  attach(httpServer: HttpServer): void {
    httpServer.on('upgrade', (request, socket, head) => {
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      );

      if (url.pathname !== this.path) {
        // Not ours. If nobody else is listening for an upgrade, the
        // socket would hang, so it is closed — but only when this server
        // is the only one that could have handled it.
        if (httpServer.listenerCount('upgrade') === 1) {
          socket.destroy();
        }
        return;
      }

      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.onConnection(ws, url);
      });
    });
  }

  /** Closes every socket. */
  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      for (const client of this.wss.clients) {
        try {
          client.close(1001, 'The server is shutting down.');
        } catch {
          // A socket that is already gone is not a problem.
        }
      }
      this.wss.close(() => resolve());
    });
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private onConnection(ws: WebSocket, url: URL): void {
    const sessionId = url.searchParams.get('session') ?? '';

    if (!sessionId) {
      // A socket without a session has nothing to listen to.
      ws.close(4000, 'A session id is required.');
      return;
    }

    const hub = this.options.hub;
    const session = hub.session(sessionId);
    hub.markActive(sessionId);

    const unsubscribe = session.subscribe((frame) => {
      send(ws, frame);
    });

    // The client is told what to expect next, before anything else.
    send(
      ws,
      controlFrame({
        sessionId,
        type: 'hello',
        data: {
          nextSeq: session.nextSeq,
          session: sessionId,
          serverTime: new Date().toISOString(),
        },
      }),
    );

    const lastSeq = parseSeq(url.searchParams.get('lastSeq'));
    if (lastSeq !== null) {
      this.replay(ws, sessionId, lastSeq);
    }

    ws.on('message', (raw) => {
      void this.onClientFrame(ws, sessionId, raw.toString());
    });

    ws.on('close', () => {
      unsubscribe();
    });

    ws.on('error', () => {
      unsubscribe();
    });
  }

  /**
   * Puts the frames a client missed back together.
   *
   * The frames come from the ring buffer, then from the database. What
   * cannot be found is reported as a gap: the client is never left
   * silently missing frames.
   */
  private replay(ws: WebSocket, sessionId: string, lastSeq: number): void {
    const { frames, gaps } = this.options.hub.replay(sessionId, lastSeq);

    if (frames.length > 0) {
      send(
        ws,
        controlFrame({
          sessionId,
          type: 'replayed',
          data: {
            from: frames[0]!.seq,
            to: frames[frames.length - 1]!.seq,
          },
        }),
      );
      for (const frame of frames) send(ws, frame);
    }

    for (const gap of gaps) {
      send(
        ws,
        controlFrame({
          sessionId,
          type: 'gap',
          data: { from: gap.from, to: gap.to, reason: gap.reason },
        }),
      );
    }
  }

  /** Handles one frame from the client. */
  private async onClientFrame(
    ws: WebSocket,
    sessionId: string,
    raw: string,
  ): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (!frame || typeof frame !== 'object') return;
    const record = frame as Record<string, unknown>;

    switch (record.type) {
      case 'ping': {
        send(ws, controlFrame({ sessionId, type: 'pong', data: {} }));
        return;
      }

      case 'resume': {
        const lastSeq = parseSeq(
          record.lastSeq === undefined ? null : String(record.lastSeq),
        );
        if (lastSeq !== null) this.replay(ws, sessionId, lastSeq);
        return;
      }

      case 'decide': {
        const requestId = String(record.requestId ?? '');
        const decision = record.decision === 'allow' ? 'allow' : 'deny';
        const remember = record.remember === true;
        if (!requestId) return;
        await this.options.onDecide?.({
          sessionId,
          requestId,
          decision,
          remember,
        });
        return;
      }

      case 'answer': {
        const requestId = String(record.requestId ?? '');
        const text = String(record.text ?? '');
        if (!requestId) return;
        await this.options.onAnswer?.({ sessionId, requestId, text });
        return;
      }

      default:
        return;
    }
  }
}

/** Parses a sequence number from the query string. */
function parseSeq(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

/** Sends a frame, if the socket is still open. */
function send(ws: WebSocket, frame: LiveFrame): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // A socket that went away between the check and the send is not a
    // problem: the client will reconnect and ask for what it missed.
  }
}
