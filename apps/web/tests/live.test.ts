import { afterEach, describe, expect, it, vi } from 'vitest';

import { LiveClient, type LiveFrame, type SocketLike } from '../lib/live';

/**
 * The socket client.
 *
 * The rules under test: the URL is relative to the page, frames are
 * applied in order, a hole in the sequence is reported and filled, and a
 * dropped connection reconnects without losing anything.
 */

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];

  sent: string[] = [];
  closed = false;
  private handlers = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    handler: (event: unknown) => void,
  ): void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.handlers.get(type) ?? []) handler(event);
  }

  get sentFrames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function frame(seq: number, type: string, data: unknown = {}): LiveFrame {
  return {
    seq,
    sessionId: 'ses_1',
    runId: 'run_1',
    ts: '2026-10-22T09:14:22.401Z',
    type,
    data,
  };
}

afterEach(() => {
  FakeSocket.instances = [];
  vi.useRealTimers();
});

describe('LiveClient', () => {
  it('connects to a relative path on the page origin', () => {
    const client = new LiveClient({
      sessionId: 'ses_1',
      origin: 'https://muca.example',
      createSocket: (url) => new FakeSocket(url),
      onFrame: () => undefined,
    });
    client.connect();

    const socket = FakeSocket.instances[0];
    expect(socket.url).toBe('wss://muca.example/api/v1/ws?session=ses_1');
    // The URL comes from the page: no port, no foreign host.
    expect(new URL(socket.url).port).toBe('');
    expect(new URL(socket.url).pathname).toBe('/api/v1/ws');
    client.close();
  });

  it('asks for the frames it is missing after a drop', () => {
    const frames: LiveFrame[] = [];
    const client = new LiveClient({
      sessionId: 'ses_1',
      origin: 'https://muca.test',
      createSocket: (url) => new FakeSocket(url),
      onFrame: (received) => frames.push(received),
    });
    client.connect();

    const socket = FakeSocket.instances[0];
    socket.emit('open', {});
    socket.emit('message', { data: JSON.stringify(frame(1, 'hello')) });
    socket.emit('message', { data: JSON.stringify(frame(2, 'run_started')) });

    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
    expect(client.lastSeq).toBe(2);
    client.close();
  });

  it('buffers an out-of-order frame and applies it in order', () => {
    const frames: LiveFrame[] = [];
    const client = new LiveClient({
      sessionId: 'ses_1',
      origin: 'https://muca.test',
      createSocket: (url) => new FakeSocket(url),
      onFrame: (received) => frames.push(received),
    });
    client.connect();

    const socket = FakeSocket.instances[0];
    socket.emit('open', {});
    socket.emit('message', { data: JSON.stringify(frame(1, 'hello')) });
    // 3 arrives before 2.
    socket.emit('message', { data: JSON.stringify(frame(3, 'run_started')) });

    expect(frames.map((f) => f.seq)).toEqual([1]);
    expect(client.lastSeq).toBe(1);
    expect(socket.sentFrames).toContainEqual({ type: 'resume', lastSeq: 1 });

    socket.emit('message', { data: JSON.stringify(frame(2, 'run_started')) });
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(client.lastSeq).toBe(3);
    client.close();
  });

  it('ignores a frame it already has', () => {
    const frames: LiveFrame[] = [];
    const client = new LiveClient({
      sessionId: 'ses_1',
      origin: 'https://muca.test',
      createSocket: (url) => new FakeSocket(url),
      onFrame: (received) => frames.push(received),
    });
    client.connect();

    const socket = FakeSocket.instances[0];
    socket.emit('open', {});
    socket.emit('message', { data: JSON.stringify(frame(1, 'hello')) });
    socket.emit('message', { data: JSON.stringify(frame(1, 'hello')) });

    expect(frames).toHaveLength(1);
    client.close();
  });

  it('reconnects and asks for everything it missed', () => {
    vi.useFakeTimers();
    const client = new LiveClient({
      sessionId: 'ses_1',
      origin: 'https://muca.test',
      createSocket: (url) => new FakeSocket(url),
      onFrame: () => undefined,
    });
    client.connect();

    const first = FakeSocket.instances[0];
    first.emit('open', {});
    for (let seq = 1; seq <= 7; seq += 1) {
      first.emit('message', {
        data: JSON.stringify(frame(seq, 'run_started')),
      });
    }
    first.emit('close', {});

    vi.advanceTimersByTime(2000);

    expect(FakeSocket.instances).toHaveLength(2);
    const second = FakeSocket.instances[1];
    expect(second.url).toContain('lastSeq=7');
    client.close();
  });

  it('reports a gap the server cannot replay', () => {
    const gaps: Array<[number, number]> = [];
    const client = new LiveClient({
      sessionId: 'ses_1',
      origin: 'https://muca.test',
      createSocket: (url) => new FakeSocket(url),
      onFrame: () => undefined,
      onGap: (from, to) => gaps.push([from, to]),
    });
    client.connect();

    const socket = FakeSocket.instances[0];
    socket.emit('open', {});
    socket.emit('message', {
      data: JSON.stringify({ ...frame(2, 'gap'), data: { from: 4, to: 9, reason: 'too old' } }),
    });

    expect(gaps).toEqual([[4, 9]]);
    client.close();
  });

  it('does not send anything while it is not live', () => {
    const client = new LiveClient({
      sessionId: 'ses_1',
      origin: 'https://muca.test',
      createSocket: (url) => new FakeSocket(url),
      onFrame: () => undefined,
    });
    client.connect();

    expect(
      client.send({ type: 'ping' }),
    ).toBe(false);
    client.close();
  });
});
