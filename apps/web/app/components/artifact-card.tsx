'use client';

import { useId, useState } from 'react';

import type { Artifact, ArtifactStatus } from '../../lib/artifacts';

const STATUS_TONE: Record<ArtifactStatus, string> = {
  success:
    'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
  failed:
    'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200',
  in_progress:
    'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  queued:
    'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  cancelled:
    'border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300',
  neutral:
    'border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300',
  unknown:
    'border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300',
};

const STATUS_LABEL: Record<ArtifactStatus, string> = {
  success: 'ok',
  failed: 'failed',
  in_progress: 'running',
  queued: 'queued',
  cancelled: 'cancelled',
  neutral: '',
  unknown: 'unknown',
};

function StatusBadge({ status }: { status: ArtifactStatus }) {
  const label = STATUS_LABEL[status];
  if (!label) return null;
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${STATUS_TONE[status]}`}
    >
      {label}
    </span>
  );
}

/**
 * An artifact card.
 *
 * The rule this follows: a judge reads the outcome without expanding
 * anything. The title, the status and the key fields are always visible.
 * The raw payload is one click away, but never in the way.
 */
export function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const [showRaw, setShowRaw] = useState(false);
  const rawId = useId();

  return (
    <article className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900/60">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-neutral-100 px-3.5 py-2.5 dark:border-neutral-800">
        <div className="min-w-0">
          <h4 className="truncate text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
            {artifact.title}
          </h4>
          {artifact.subtitle ? (
            <p className="mt-0.5 text-[12px] leading-relaxed text-neutral-600 dark:text-neutral-400">
              {artifact.subtitle}
            </p>
          ) : null}
        </div>
        <StatusBadge status={artifact.status} />
      </header>

      {artifact.fields.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3.5 py-3 sm:grid-cols-3">
          {artifact.fields.map((field) => (
            <div
              key={`${field.label}-${field.value}`}
              className={field.block ? 'col-span-2 sm:col-span-3' : 'min-w-0'}
            >
              <dt className="text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                {field.label}
              </dt>
              <dd
                className={`mt-0.5 truncate text-[12px] text-neutral-800 dark:text-neutral-200 ${
                  field.mono ? 'font-mono' : ''
                }`}
              >
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {artifact.body ? (
        <pre className="mx-3.5 mb-3 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-neutral-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-700 dark:bg-neutral-950/60 dark:text-neutral-300">
          {artifact.body}
        </pre>
      ) : null}

      {artifact.lines && artifact.lines.length > 0 ? (
        <ul className="mx-3.5 mb-3 space-y-1">
          {artifact.lines.map((line, index) => (
            <li
              key={`${index}-${line.slice(0, 24)}`}
              className="truncate font-mono text-[11px] text-neutral-600 dark:text-neutral-400"
            >
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      {artifact.raw !== undefined ? (
        <div className="border-t border-neutral-100 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => setShowRaw((value) => !value)}
            aria-expanded={showRaw}
            aria-controls={rawId}
            className="flex w-full items-center gap-1.5 px-3.5 py-2 text-left text-[11px] font-medium text-neutral-500 transition hover:text-neutral-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 dark:focus-visible:outline-neutral-100"
          >
            <span aria-hidden="true" className="text-[9px]">
              {showRaw ? '▾' : '▸'}
            </span>
            {showRaw ? 'Hide raw result' : 'Show raw result'}
          </button>
          {showRaw ? (
            <pre
              id={rawId}
              className="max-h-72 overflow-auto border-t border-neutral-100 bg-neutral-50/60 px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950/50 dark:text-neutral-400"
            >
              {safeStringify(artifact.raw)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
