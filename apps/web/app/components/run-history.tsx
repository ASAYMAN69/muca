'use client';

import { useEffect, useState } from 'react';

import { fetchRuns, type RunRecord } from '../../lib/api';

function formatWhen(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const OUTCOME_TONE: Record<string, string> = {
  completed:
    'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  awaiting_approval:
    'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  error:
    'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
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
      <section className="mt-4 rounded-xl border border-neutral-200 bg-white/70 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/50">
        <p className="text-[12px] text-neutral-500 dark:text-neutral-400">
          Loading run history…
        </p>
      </section>
    );
  }

  if (runs.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="run-history-heading"
      className="mt-4 rounded-xl border border-neutral-200 bg-white/70 backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-900/50"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="run-history-body"
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-100"
      >
        <span>
          <span
            id="run-history-heading"
            className="block text-[13px] font-semibold text-neutral-900 dark:text-neutral-100"
          >
            Previous runs
          </span>
          <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">
            {runs.length} run{runs.length === 1 ? '' : 's'} in this session
          </span>
        </span>
        <span aria-hidden="true" className="text-[10px] text-neutral-400">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open ? (
        <ul id="run-history-body" className="border-t border-neutral-200 dark:border-neutral-800">
          {runs.map((run) => {
            const tone =
              OUTCOME_TONE[run.outcome ?? ''] ??
              'border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400';
            return (
              <li
                key={run.id}
                className="border-b border-neutral-100 px-4 py-2.5 last:border-b-0 dark:border-neutral-800"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 flex-1 truncate text-[12px] text-neutral-800 dark:text-neutral-200">
                    {run.userMessage ?? run.id}
                  </p>
                  <span
                    className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium ${tone}`}
                  >
                    {run.outcome ?? 'unknown'}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] text-neutral-400 dark:text-neutral-500">
                  {formatWhen(run.startedAt)}
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
