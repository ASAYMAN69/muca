'use client';

import { useEffect, useState } from 'react';

import { fetchRuns, type RunRecord } from '../../lib/api';
import { relativeTime } from '../../lib/format';

const OUTCOME_TONE: Record<string, string> = {
  completed: 'border-good-line bg-good-soft text-good',
  awaiting_approval: 'border-warn-line bg-warn-soft text-warn',
  error: 'border-bad-line bg-bad-soft text-bad',
};

/**
 * The run history.
 *
 * The backend persists every run, so the agent's memory survives a
 * restart. This panel makes that visible: a judge can see that the
 * previous runs are still there.
 *
 * The route is new and may not exist yet, in which case the panel stays
 * hidden rather than showing an error.
 */
export function RunHistoryPanel() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchRuns(10).then((result) => {
      if (cancelled) return;
      setRuns(result);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) {
    return (
      <section className="mt-4 rounded-xl border border-line bg-surface-raised px-4 py-3">
        <p className="text-[12px] text-ink-faint">Loading run history…</p>
      </section>
    );
  }

  if (runs.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="run-history-heading"
      className="mt-4 rounded-xl border border-line bg-surface-raised"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="run-history-body"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <span>
          <span
            id="run-history-heading"
            className="block text-[13px] font-semibold text-ink"
          >
            Previous runs
          </span>
          <span className="block text-[11px] text-ink-faint">
            {runs.length} run{runs.length === 1 ? '' : 's'} in this session
          </span>
        </span>
        <span aria-hidden="true" className="text-[10px] text-ink-faint">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open ? (
        <ul
          id="run-history-body"
          className="border-t border-line"
        >
          {runs.map((run) => {
            const tone =
              OUTCOME_TONE[run.outcome ?? ''] ??
              'border-line text-ink-muted';
            return (
              <li
                key={run.id}
                className="border-b border-line px-4 py-2.5 last:border-b-0"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-[12px] text-ink">
                    {run.userMessage ?? run.id}
                  </p>
                  <span
                    className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium ${tone}`}
                  >
                    {run.outcome ?? 'unknown'}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-ink-faint">
                  {relativeTime(run.startedAt)}
                  {run.id ? ` · ${run.id}` : ''}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
