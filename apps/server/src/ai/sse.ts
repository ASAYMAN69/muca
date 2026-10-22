/**
 * Server-sent events.
 *
 * Anthropic and OpenAI stream `text/event-stream`; Gemini streams the
 * same format when it is asked for `alt=sse`. The parser is deliberately
 * small: it finds the `data:` lines, joins them, and hands the payload
 * to the caller.
 */

/** One event from the stream. */
export interface SseEvent {
  /** The `event:` name, when the stream gave one. */
  event?: string;
  /** The joined `data:` payload. */
  data: string;
}

/**
 * Parses a byte stream into SSE events.
 *
 * The stream is chunked arbitrarily, so a `data:` line can be split
 * across two chunks. The parser buffers until it has a complete line.
 */
export async function* parseSse(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      const parsed = parseLine(line);
      if (parsed) yield parsed;
      newline = buffer.indexOf('\n');
    }
  }

  // Whatever is left after the last newline is a final line.
  const tail = buffer.replace(/\r$/, '');
  if (tail.length > 0) {
    const parsed = parseLine(tail);
    if (parsed) yield parsed;
  }
}

/**
 * Parses one line of an SSE stream.
 *
 * Returns null for a line that carries no data: a comment (`: …`), a
 * field the parser does not use, or a blank separator line.
 */
function parseLine(line: string): SseEvent | null {
  if (line === '' || line.startsWith(':')) return null;

  const separator = line.indexOf(':');
  const field = separator === -1 ? line : line.slice(0, separator);
  let value = separator === -1 ? '' : line.slice(separator + 1);
  if (value.startsWith(' ')) value = value.slice(1);

  if (field === 'data') {
    return { data: value };
  }

  if (field === 'event') {
    // The event name is only meaningful together with the data that
    // follows it, so it is carried on the next `data` line.
    return { event: value, data: '' };
  }

  return null;
}

/**
 * Merges an SSE stream into the events, keeping the `event:` name.
 *
 * The `event:` line and the `data:` line are separate in the wire
 * format, but the name describes the data that follows it. This helper
 * joins them, so a caller sees `{ event: 'content_block_delta', data: '…' }`.
 */
export async function* readSseEvents(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<SseEvent> {
  let pendingEvent: string | undefined;

  for await (const event of parseSse(stream)) {
    if (event.event !== undefined && event.data === '') {
      pendingEvent = event.event;
      continue;
    }
    yield { event: pendingEvent ?? event.event, data: event.data };
    pendingEvent = undefined;
  }
}

/**
 * Reads a `fetch` response body as a stream of bytes.
 *
 * Returns null when the response has no body, so a caller can fall back
 * to reading the whole thing as text.
 */
export function bodyStream(
  response: { body?: unknown },
): AsyncIterable<Uint8Array> | null {
  const body = response.body as
    | (AsyncIterable<Uint8Array> & { getReader?: unknown })
    | null
    | undefined;
  if (!body) return null;
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    return body as AsyncIterable<Uint8Array>;
  }
  return null;
}
