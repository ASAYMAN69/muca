/**
 * Time and text helpers.
 *
 * Dates are formatted with `Intl`, never with a hand-rolled pattern, so
 * the app reads the way the reader's locale expects.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 60 * 60 * 1000],
  ['month', 30 * 24 * 60 * 60 * 1000],
  ['week', 7 * 24 * 60 * 60 * 1000],
  ['day', 24 * 60 * 60 * 1000],
  ['hour', 60 * 60 * 1000],
  ['minute', 60 * 1000],
];

/** "3 minutes ago", "yesterday", "now". */
export function relativeTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';

  const diff = time - Date.now();
  const magnitude = Math.abs(diff);
  if (magnitude < 45 * 1000) return 'just now';

  for (const [unit, size] of UNITS) {
    if (magnitude >= size) {
      return RELATIVE.format(Math.round(diff / size), unit);
    }
  }
  return RELATIVE.format(Math.round(diff / 60_000), 'minute');
}

/** A full date and time, for tooltips and details. */
export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** A duration in milliseconds, in words. */
export function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes} min ${rest} s`;
}

/**
 * A title from a first message.
 *
 * The server may name a session itself. When it does not, the client
 * derives one: the first line, trimmed to something that fits a row.
 */
export function deriveTitle(message: string | undefined | null): string {
  const text = (message ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return 'New session';
  if (text.length <= 48) return text;
  const cut = text.slice(0, 48);
  const space = cut.lastIndexOf(' ');
  return `${(space > 24 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
