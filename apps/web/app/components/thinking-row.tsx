'use client';

import { useId, useState } from 'react';

/**
 * The thinking row.
 *
 * While the model is reasoning, this row is alive: a slow pulse and the
 * tail of what it is thinking. When the turn ends it collapses into a
 * one-line summary, so the timeline keeps its shape and the reasoning
 * stays one click away.
 *
 * The pulse is motion-safe only, and it is the only thing on screen that
 * moves on its own.
 */
export function ThinkingRow({
  text,
  active,
}: {
  text: string;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trimmed = text.trim();

  if (!trimmed) return null;

  const summary = firstSentence(trimmed);

  if (!active) {
    return (
      <div className="flex items-start gap-2 text-[12px] text-ink-faint">
        <span aria-hidden="true" className="mt-[3px] text-[10px]">
          ◇
        </span>
        <div className="min-w-0">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((value) => !value)}
            className="block w-full truncate text-left transition-colors duration-150 hover:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Thought about {summary}
          </button>
          {open ? (
            <p
              id={id}
              className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted"
            >
              {trimmed}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 text-[12px] text-ink-muted">
      <span
        aria-hidden="true"
        className="mt-[3px] size-1.5 shrink-0 rounded-full bg-accent motion-safe:animate-pulse"
      />
      <p className="min-w-0 flex-1 leading-relaxed">
        <span className="text-ink-faint">Thinking… </span>
        {tail(trimmed)}
      </p>
    </div>
  );
}

/** The first sentence, shortened: a summary of the reasoning. */
function firstSentence(text: string): string {
  const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
  const short = sentence.length > 90 ? `${sentence.slice(0, 90).trimEnd()}…` : sentence;
  return short;
}

/** The tail of the text: what is happening right now. */
function tail(text: string): string {
  return text.length > 220 ? `…${text.slice(-220)}` : text;
}
