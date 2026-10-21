'use client';

import { useId, useState } from 'react';

import type { PendingCall } from '../../lib/api';
import type { TimelineStep } from '../../lib/timeline';
import { ArtifactCard } from './artifact-card';
import type { Artifact } from '../../lib/artifacts';
import { renderMarkdown } from '../../lib/markdown';

const STEP_TONE: Record<
  TimelineStep['status'],
  { dot: string; ring: string; label: string }
> = {
  pending: {
    dot: 'bg-neutral-300 dark:bg-neutral-600',
    ring: 'ring-neutral-200 dark:ring-neutral-800',
    label: 'pending',
  },
  running: {
    dot: 'bg-amber-500 motion-safe:animate-pulse',
    ring: 'ring-amber-200 dark:ring-amber-900',
    label: 'running',
  },
  success: {
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-200 dark:ring-emerald-900',
    label: 'ok',
  },
  failed: {
    dot: 'bg-red-500',
    ring: 'ring-red-200 dark:ring-red-900',
    label: 'failed',
  },
  blocked: {
    dot: 'bg-amber-500',
    ring: 'ring-amber-200 dark:ring-amber-900',
    label: 'waiting',
  },
  rejected: {
    dot: 'bg-neutral-400',
    ring: 'ring-neutral-200 dark:ring-neutral-800',
    label: 'declined',
  },
};

/** The approval prompt. Deliberate, explicit, and keyboard-operable. */
function ApprovalStep({
  step,
  pending,
  busy,
  onApprove,
  onReject,
}: {
  step: TimelineStep;
  pending: PendingCall | null;
  busy: boolean;
  onApprove: (pending: PendingCall) => void;
  onReject: (pending: PendingCall) => void;
}) {
  const argsId = useId();
  const live = pending && pending.callId === step.callId;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/70 dark:border-amber-700 dark:bg-amber-950/25">
      <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 px-3.5 py-2.5 dark:border-amber-800/60">
        <span className="rounded border border-amber-400 bg-amber-100 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-200">
          Consequential
        </span>
        <span className="text-[13px] font-semibold text-amber-950 dark:text-amber-100">
          Approval required
        </span>
      </div>

      <div className="space-y-3 px-3.5 py-3">
        <p className="text-[13px] leading-relaxed text-amber-900 dark:text-amber-100">
          {step.summary ?? pending?.message ?? 'The agent wants to run a tool.'}
        </p>

        <div>
          <h4
            id={argsId}
            className="text-[10px] font-semibold uppercase tracking-wider text-amber-700/80 dark:text-amber-300/80"
          >
            What will happen
          </h4>
          <dl
            aria-labelledby={argsId}
            className="mt-1.5 divide-y divide-amber-200/70 rounded-md border border-amber-200 bg-white/60 dark:divide-amber-800/60 dark:border-amber-800/60 dark:bg-neutral-950/25"
          >
            {(step.arguments ?? []).map((arg) => (
              <div
                key={arg.key}
                className="flex flex-wrap items-baseline gap-x-2 px-2.5 py-1.5"
              >
                <dt className="font-mono text-[11px] text-amber-700/90 dark:text-amber-300/80">
                  {arg.key}
                </dt>
                <dd className="min-w-0 flex-1 break-words font-mono text-[11px] text-amber-950 dark:text-amber-100">
                  {arg.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        <p className="text-[12px] leading-relaxed text-amber-800/90 dark:text-amber-200/80">
          This changes something outside Muca. It only runs if you approve it.
        </p>

        {live ? (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => pending && onApprove(pending)}
              disabled={busy}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-[13px] font-semibold text-white transition hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-50 dark:focus-visible:outline-amber-400"
            >
              {busy ? 'Running…' : 'Approve & run'}
            </button>
            <button
              type="button"
              onClick={() => pending && onReject(pending)}
              disabled={busy}
              className="rounded-md border border-amber-400 px-3 py-1.5 text-[13px] font-medium text-amber-900 transition hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-50 dark:text-amber-100 dark:hover:bg-amber-900/40 dark:focus-visible:outline-amber-400"
            >
              Cancel
            </button>
          </div>
        ) : (
          <p className="text-[12px] italic text-amber-700/80 dark:text-amber-300/70">
            This approval was already answered.
          </p>
        )}
      </div>
    </div>
  );
}

/** One step in the timeline. */
function Step({
  step,
  artifacts,
  pending,
  busy,
  onApprove,
  onReject,
}: {
  step: TimelineStep;
  artifacts: Artifact[];
  pending: PendingCall | null;
  busy: boolean;
  onApprove: (pending: PendingCall) => void;
  onReject: (pending: PendingCall) => void;
}) {
  const tone = STEP_TONE[step.status];
  const isApproval = step.kind === 'approval';

  return (
    <li className="relative pl-7">
      {/* The spine */}
      <span
        aria-hidden="true"
        className={`absolute left-[7px] top-2 size-2.5 rounded-full ring-4 ${tone.dot} ${tone.ring}`}
      />

      <div className="pb-5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3
            className={`text-[13px] font-semibold ${
              isApproval
                ? 'text-amber-950 dark:text-amber-100'
                : 'text-neutral-900 dark:text-neutral-100'
            }`}
          >
            {step.title}
          </h3>
          {step.toolName ? (
            <code className="rounded bg-neutral-100 px-1.5 py-px font-mono text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
              {step.toolName}
            </code>
          ) : null}
          {step.destructive ? (
            <span className="rounded-full border border-red-300 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:border-red-800 dark:text-red-300">
              destructive
            </span>
          ) : null}
          <span className="text-[10px] uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
            {tone.label}
          </span>
        </div>

        {step.summary && step.kind !== 'approval' ? (
          <p className="mt-1 text-[12px] leading-relaxed text-neutral-600 dark:text-neutral-400">
            {step.summary}
          </p>
        ) : null}

        {step.arguments && step.arguments.length > 0 &&
        (step.kind === 'tool_call' ||
          (step.kind === 'approval' && step.status !== 'blocked')) ? (
          <ArgumentList step={step} />
        ) : null}
        {/* When an artifact card covers the result, the raw summary would
            say the same thing twice. The card wins. */}
        {step.kind === 'evidence' && step.resultSummary && artifacts.length === 0 ? (
          <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-neutral-700 dark:text-neutral-300">
            {step.resultSummary}
          </p>
        ) : null}
        {step.kind === 'error' ? (
          <p
            role="alert"
            className="mt-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-[12px] leading-relaxed text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            {step.summary}
          </p>
        ) : null}

        {isApproval && step.status === 'blocked' ? (
          <div className="mt-2.5">
            <ApprovalStep
              step={step}
              pending={pending}
              busy={busy}
              onApprove={onApprove}
              onReject={onReject}
            />
          </div>
        ) : null}

        {artifacts.length > 0 ? (
          <div className="mt-2.5 space-y-2.5">
            {artifacts.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ArgumentList({ step }: { step: TimelineStep }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const args = step.arguments ?? [];

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={id}
        className="inline-flex items-center gap-1.5 rounded text-[11px] font-medium text-neutral-500 transition hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100 dark:focus-visible:outline-neutral-100"
      >
        <span aria-hidden="true" className="text-[9px]">
          {open ? '▾' : '▸'}
        </span>
        {open ? 'Hide arguments' : `Show arguments (${args.length})`}
      </button>
      {open ? (
        <dl
          id={id}
          className="mt-1.5 divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-neutral-50/60 dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-950/40"
        >
          {args.map((arg) => (
            <div key={arg.key} className="flex flex-wrap gap-x-2 px-2.5 py-1.5">
              <dt className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                {arg.key}
              </dt>
              <dd className="min-w-0 flex-1 break-words font-mono text-[11px] text-neutral-800 dark:text-neutral-200">
                {arg.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

/**
 * The run timeline.
 *
 * The request and the outcome are the loud parts; the mechanics are
 * quiet. The raw JSON is one click away in every expandable region.
 */
export function TimelineView({
  steps,
  artifactsByStep,
  outcome,
  pending,
  busy,
  onApprove,
  onReject,
  demo,
}: {
  steps: TimelineStep[];
  artifactsByStep: Map<string, Artifact[]>;
  outcome?: string;
  pending: PendingCall | null;
  busy: boolean;
  onApprove: (pending: PendingCall) => void;
  onReject: (pending: PendingCall) => void;
  demo?: boolean;
}) {
  return (
    <div className="space-y-6">
      {steps.length > 0 ? (
        <ol className="relative">
          {/* The vertical spine the step dots sit on. */}
          <span
            aria-hidden="true"
            className="absolute left-[13px] top-2 bottom-2 w-px bg-neutral-200 dark:bg-neutral-800"
          />
          {steps.map((step) => (
            <Step
              key={step.id}
              step={step}
              artifacts={artifactsByStep.get(step.id) ?? []}
              pending={pending}
              busy={busy}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </ol>
      ) : null}

      {outcome ? (
        <section
          aria-labelledby="outcome-heading"
          className={`rounded-xl border p-4 ${
            demo
              ? 'border-dashed border-amber-400 bg-amber-50/50 dark:border-amber-700 dark:bg-amber-950/20'
              : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900/50'
          }`}
        >
          <h3
            id="outcome-heading"
            className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400"
          >
            Outcome
          </h3>
          <div className="mt-2 space-y-2 text-[14px] leading-relaxed text-neutral-800 dark:text-neutral-200">
            {renderMarkdown(outcome)}
          </div>
        </section>
      ) : null}
    </div>
  );
}
