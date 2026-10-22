import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

import { LiveSocketServer } from '../src/live/ws-server.js';
import { LiveHub, findGaps } from '../src/live/hub.js';
import { MucaStore } from '../src/store/index.js';

/**
 * The live socket.
 *
 * The rule the whole protocol rests on: **the server must never silently
 * skip frames.** Either the client receives every sequence number, or
 * it is told about the gap.
 */
describe('the live socket', () => {
  let httpServer: Server;
  let hub: LiveHub;
  let sockets: LiveSocketServer;
  let dir: string;
  let store: MucaStore;
  let baseUrl: string;

  const decisions: Array<{
    sessionId: string;
    requestId: string;
    decision: string;
    remember: boolean;
  }> = [];
  const answers: Array<{ sessionId: string; requestId: string; text: string }> = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'muca-ws-'));
    store = new MucaStore(join(dir, 'muca.db'));
    hub = new LiveHub(store.events);

    sockets = new LiveSocketServer({
      hub,
      onDecide: (input) => {
        decisions.push(input);
      },
      onAnswer: (input) => {
        answers.push(input);
      },
    });

    httpServer = createServer((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    sockets.attach(httpServer);

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `ws://127.0.0.1:${port}/api/v1/ws`;
  });

  afterEach(async () => {
    await sockets.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Opens a socket and collects the frames. */
  function connect(
    query: string,
  ): { socket: WebSocket; frames: Array<Record<string, unknown>>; close: () => void } {
    const socket = new WebSocket(`${baseUrl}${query}`);
    const frames: Array<Record<string, unknown>> = [];

    socket.on('message', (raw) => {
      frames.push(JSON.parse(raw.toString()) as Record<string, unknown>);
    });

    return {
      socket,
      frames,
      close: () => socket.close(),
    };
  }

  /** Waits until the predicate holds, or fails. */
  async function waitFor(
    frames: Array<Record<string, unknown>>,
    predicate: (frames: Array<Record<string, unknown>>) => boolean,
    what: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate(frames)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${what}.`);
  }

  it('sends a hello frame first', async () => {
    const client = connect('?session=ses_1');
    await waitFor(client.frames, (f) => f.length >= 1, 'the hello frame');

    const hello = client.frames[0]!;
    expect(hello.type).toBe('hello');
    expect(hello.sessionId).toBe('ses_1');
    expect((hello.data as { nextSeq: number }).nextSeq).toBe(1);
    expect((hello.data as { serverTime: string }).serverTime).toBeTruthy();

    client.close();
  });

  it('refuses a socket without a session', async () => {
    // The socket is closed with a code that says why.
    const code = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(baseUrl);
      socket.on('close', (closed) => resolve(closed));
      socket.on('error', () => {
        // A socket that never opens is closed too; the code is what
        // matters.
      });
      setTimeout(() => reject(new Error('Timed out waiting for the close.')), 5000);
    });

    expect(code).toBe(4000);
  });

  it('gives every frame a strictly increasing sequence number', async () => {
    const client = connect('?session=ses_1');
    await waitFor(client.frames, (f) => f.length >= 1, 'the hello frame');

    hub.publish('ses_1', 'run_started', { message: 'hello' });
    hub.publish('ses_1', 'message_delta', { text: 'hi' });
    hub.publish('ses_1', 'run_finished', { outcome: 'completed' });

    await waitFor(
      client.frames,
      (f) => f.filter((frame) => typeof frame.seq === 'number').length === 3,
      'the three frames',
    );

    const seqs = client.frames
      .filter((frame) => typeof frame.seq === 'number')
      .map((frame) => frame.seq as number);

    expect(seqs).toEqual([1, 2, 3]);
    client.close();
  });

  it('replays the frames a client missed when it reconnects', async () => {
    // The client sees the first two frames, then the socket drops.
    const first = connect('?session=ses_1');
    await waitFor(first.frames, (f) => f.length >= 1, 'the hello frame');

    hub.publish('ses_1', 'message_delta', { text: 'one' });
    hub.publish('ses_1', 'message_delta', { text: 'two' });
    await waitFor(
      first.frames,
      (f) => f.filter((frame) => typeof frame.seq === 'number').length === 2,
      'the two frames',
    );
    first.close();

    // Two more frames happen while the client is away.
    hub.publish('ses_1', 'message_delta', { text: 'three' });
    hub.publish('ses_1', 'message_delta', { text: 'four' });

    // The client comes back and says what it has.
    const second = connect('?session=ses_1&lastSeq=2');
    await waitFor(
      second.frames,
      (f) => f.filter((frame) => typeof frame.seq === 'number').length === 2,
      'the replayed frames',
    );

    const replayed = second.frames.filter((frame) => typeof frame.seq === 'number');
    expect(replayed.map((frame) => frame.seq)).toEqual([3, 4]);
    expect(replayed[0]?.type).toBe('message_delta');
    expect((replayed[0]?.data as { text: string }).text).toBe('three');

    second.close();
  });

  it('replays on demand when the client asks', async () => {
    const client = connect('?session=ses_1');
    await waitFor(client.frames, (f) => f.length >= 1, 'the hello frame');

    hub.publish('ses_1', 'message_delta', { text: 'one' });
    await waitFor(
      client.frames,
      (f) => f.filter((frame) => typeof frame.seq === 'number').length === 1,
      'the first frame',
    );

    // The client says "resume from 0" and gets the frame again.
    client.socket.send(JSON.stringify({ type: 'resume', lastSeq: 0 }));
    await waitFor(
      client.frames,
      (f) => f.filter((frame) => frame.type === 'replayed').length === 1,
      'the replayed marker',
    );

    second: {
      const replayed = client.frames.filter((frame) => frame.type === 'replayed');
      expect(replayed.length).toBe(1);
      expect((replayed[0]?.data as { from: number }).from).toBe(1);
    }

    client.close();
  });

  it('tells the client about a gap when the frames are gone', async () => {
    // More frames than the ring buffer holds, so the oldest ones fall
    // out of memory and are not in the database either.
    for (let index = 0; index < 2100; index += 1) {
      hub.publish('ses_1', 'message_delta', { text: `frame ${index}` });
    }

    // The client only has frame 1, which is long gone.
    const client = connect('?session=ses_1&lastSeq=1');
    await waitFor(
      client.frames,
      (f) => f.some((frame) => frame.type === 'gap'),
      'the gap frame',
    );

    const gap = client.frames.find((frame) => frame.type === 'gap')!;
    const data = gap.data as { from: number; to: number; reason: string };
    // The client has frame 1. The ring buffer holds the last 2000
    // frames, so the server can still give it 101 upwards, but the
    // frames in between are gone for good.
    expect(data.from).toBe(2);
    expect(data.to).toBe(100);
    expect(data.reason).toBeTruthy();

    // And the frames the server *can* give are still delivered.
    const delivered = client.frames.filter((frame) => typeof frame.seq === 'number');
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered[0]?.seq).toBe(101);

    client.close();
  });

  it('replays the frames from the database after a restart', async () => {
    // A run finished, so its frames were flushed to the database.
    store.events.appendMany([
      { sessionId: 'ses_1', seq: 1, runId: 'run_1', type: 'message_delta', data: { text: 'stored' }, createdAt: '2026-01-01T00:00:00.000Z' },
    ]);

    const client = connect('?session=ses_1&lastSeq=0');
    await waitFor(
      client.frames,
      (f) => f.filter((frame) => typeof frame.seq === 'number').length === 1,
      'the stored frame',
    );

    const replayed = client.frames.filter((frame) => typeof frame.seq === 'number');
    expect(replayed[0]?.seq).toBe(1);
    expect((replayed[0]?.data as { text: string }).text).toBe('stored');

    client.close();
  });

  it('answers a ping with a pong', async () => {
    const client = connect('?session=ses_1');
    await waitFor(client.frames, (f) => f.length >= 1, 'the hello frame');

    client.socket.send(JSON.stringify({ type: 'ping' }));
    await waitFor(
      client.frames,
      (f) => f.some((frame) => frame.type === 'pong'),
      'the pong frame',
    );

    client.close();
  });

  it('hands a decision to the server', async () => {
    const client = connect('?session=ses_1');
    await waitFor(client.frames, (f) => f.length >= 1, 'the hello frame');

    client.socket.send(
      JSON.stringify({
        type: 'decide',
        requestId: 'req_1',
        decision: 'allow',
        remember: true,
      }),
    );

    for (let attempt = 0; attempt < 200 && decisions.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toEqual({
      sessionId: 'ses_1',
      requestId: 'req_1',
      decision: 'allow',
      remember: true,
    });

    client.close();
  });

  it('hands an answer to the server', async () => {
    const client = connect('?session=ses_1');
    await waitFor(client.frames, (f) => f.length >= 1, 'the hello frame');

    client.socket.send(
      JSON.stringify({ type: 'answer', requestId: 'req_2', text: 'staging' }),
    );

    for (let attempt = 0; attempt < 200 && answers.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(answers).toHaveLength(1);
    expect(answers[0]?.text).toBe('staging');

    client.close();
  });

  it('ignores a frame that is not JSON', async () => {
    const client = connect('?session=ses_1');
    await waitFor(client.frames, (f) => f.length >= 1, 'the hello frame');

    client.socket.send('not json at all');
    client.socket.send(JSON.stringify({ type: 'unknown-frame' }));

    // The socket is still open.
    expect(client.socket.readyState).toBe(WebSocket.OPEN);

    client.close();
  });
});

describe('the gap finder', () => {
  it('groups the missing sequence numbers into ranges', () => {
    expect(findGaps(1, 10, [1, 2, 5, 6, 10])).toEqual([
      { from: 3, to: 4, reason: 'too old' },
      { from: 7, to: 9, reason: 'too old' },
    ]);
  });

  it('reports nothing when every number is there', () => {
    expect(findGaps(1, 3, [1, 2, 3])).toEqual([]);
  });

  it('reports nothing for an empty range', () => {
    expect(findGaps(5, 4, [])).toEqual([]);
  });
});
