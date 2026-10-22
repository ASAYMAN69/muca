'use client';

import { useId, useState } from 'react';

import type { PendingCall, ToolSummary } from '../../lib/api';
import type { TimelineStep } from '../../lib/timeline';
import { ArtifactCard } from './artifact-card';
import type { Artifact } from '../../lib/artifacts';
import { renderMarkdown } from '../../lib/markdown';
import { PermissionCard } from './permission-card';

const STEP_TONE: Record<
  TimelineStep['status'],
  { dot: string; ring: string; label: string }
> = {
  pending: {
    dot: 'bg-ink-faint',
    ring: 'ring-line',
    label: 'pending',
  },
  running: {
    dot: 'bg-accent motion-safe:animate-pulse',
    ring: 'ring-accent-line',
    label: 'running',
  },
  success: {
    dot: 'bg-good',
    ring: 'ring-good-line',
    label: 'ok',
  },
  failed: {
    dot: 'bg-bad',
    ring: 'ring-bad-line',
    label: 'failed',
  },
  blocked: {
    dot: 'bg-warn motion-safe:animate-pulse',
    ring: 'ring-warn-line',
    label: 'waiting',
  },
  rejected: {
    dot: 'bg-ink-faint',
    ring: 'ring-line',
    label: 'declined',
  },
};

/** The permission card. The decision happens here, in the timeline. */
function ApprovalStep({
  step,
  pending,
  tools,
  busy,
  live,
  onApprove,
  onReject,
  onAllowAndRemember,
}: {
  step: TimelineStep;
  pending: PendingCall | null;
  tools: ToolSummary[];
  busy: boolean;
  live: boolean;
  onApprove: (pending: PendingCall) => void;
  onReject: (pending: PendingCall) => void;
  onAllowAndRemember: (pending: PendingCall) => void;
}) {
  const live_ = pending && pending.callId === step.callId;

  if (!live_) {
    return (
      <p className="text-[12px] italic text-ink-faint">
        This approval was already answered.
      </p>
    );
  }

  return (
    <>
      <PermissionCard
        pending={pending}
        tools={tools}
        busy={busy}
        onAllow={onApprove}
        onDeny={onReject}
        onAllowAndRemember={onAllowAndRemember}
      />
      {live ? null : (
        <p className="text-[11.5px] leading-relaxed text-ink-faint">
          Live updates are off, so this decision is sent the slow way. “Allow
          and remember” needs the live socket.
        </p>
      )}
    </>
  );
}

/** A question the agent asked. */
function ClarificationStep({
  step,
  busy,
  onAnswer,
}: {
  step: TimelineStep;
  busy: boolean;
  onAnswer?: (requestId: string, answer: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const id = useId();
  const question = step.clarification?.question ?? step.summary ?? '';
  const answered = step.clarification?.answer;

  if (answered !== undefined) {
    return (
      <div className="rounded-lg border border-line bg-surface-raised px-3.5 py-3">
        <p className="text-[13px] leading-relaxed text-ink">{question}</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-muted">
          You said: {answered}
        </p>
      </div>
    );
  }

  return (
    <form
      className="rounded-lg border border-line bg-surface-raised px-3.5 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        const text = answer.trim();
        if (!text || !step.callId) return;
        onAnswer?.(step.callId, text);
        setAnswer('');
      }}
    >
      <p className="text-[13px] leading-relaxed text-ink">{question}</p>
      {step.clarification?.options?.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {step.clarification.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={busy}
              onClick={() => {
                if (!step.callId) return;
                onAnswer?.(step.callId, option);
              }}
              className="rounded-lg border border-line px-2.5 py-1 text-[12px] text-ink-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-surface-hover hover:text-ink active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-2.5 flex gap-2">
        <label htmlFor={id} className="sr-only">
          Your answer
        </label>
        <input
          id={id}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="Type your answer…"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5 text-[13px] text-ink transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-ink-faint focus:border-accent"
        />
        <button
          type="submit"
          disabled={busy || !answer.trim()}
          className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-surface transition-[filter,transform,opacity] duration-150 ease-out hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          Answer
        </button>
      </div>
    </form>
  );
}

/** One step in the timeline. */
function Step({
  step,
  artifacts,
  pending,
  tools,
  busy,
  live,
  onApprove,
  onReject,
  onAllowAndRemember,
  onAnswer,
}: {
  step: TimelineStep;
  artifacts: Artifact[];
  pending: PendingCall | null;
  tools: ToolSummary[];
  busy: boolean;
  live: boolean;
  onApprove: (pending: PendingCall) => void;
  onReject: (pending: PendingCall) => void;
  onAllowAndRemember: (pending: PendingCall) => void;
  onAnswer?: (requestId: string, answer: string) => void;
}) {
  const tone = STEP_TONE[step.status];
  const isApproval = step.kind === 'approval';
  const isClarification = step.kind === 'clarification';

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
                ? 'text-ink'
                : isClarification
                  ? 'text-ink'
                  : 'text-ink'
            }`}
          >
            {step.title}
          </h3>
          {step.toolName ? (
            <code className="rounded bg-surface-sunken px-1.5 py-px font-mono text-[11px] text-ink-muted">
              {step.toolName}
            </code>
          ) : null}
          {step.destructive ? (
            <span className="rounded-full border border-warn-line px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-warn">
              destructive
            </span>
          ) : null}
          <span className="text-[10px] uppercase tracking-[0.12em] text-ink-faint">
            {tone.label}
          </span>
        </div>

        {step.summary && step.kind !== 'approval' && !isClarification ? (
          <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
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
          <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-muted">
            {step.resultSummary}
          </p>
        ) : null}

        {step.kind === 'error' ? (
          <p
            role="alert"
            className="mt-1.5 rounded-lg border border-bad-line bg-bad-soft px-2.5 py-2 text-[12px] leading-relaxed text-bad"
          >
            {step.summary}
          </p>
        ) : null}

        {isApproval && step.status === 'blocked' && pending ? (
          <div className="mt-2.5">
            <ApprovalStep
              step={step}
              pending={pending}
              tools={tools}
              busy={busy}
              live={live}
              onApprove={onApprove}
              onReject={onReject}
              onAllowAndRemember={onAllowAndRemember}
            />
          </div>
        ) : null}

        {isClarification ? (
          <div className="mt-2.5">
            <ClarificationStep
              step={step}
              busy={busy}
              onAnswer={onAnswer}
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
        className="inline-flex items-center gap-1.5 rounded text-[11px] font-medium text-ink-faint transition-colors duration-150 hover:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <span aria-hidden="true" className="text-[9px]">
          {open ? '▾' : '▸'}
        </span>
        {open ? 'Hide arguments' : `Show arguments (${args.length})`}
      </button>
      {open ? (
        <dl
          id={id}
          className="mt-1.5 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface-sunken"
        >
          {args.map((arg) => (
            <div key={arg.key} className="flex flex-wrap gap-x-2 px-2.5 py-1.5">
              <dt className="font-mono text-[11px] text-ink-muted">{arg.key}</dt>
              <dd className="min-w-0 flex-1 break-words font-mono text-[11px] text-ink">
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
  tools,
  busy,
  live,
  onApprove,
  onReject,
  onAllowAndRemember,
  onAnswer,
  demo,
}: {
  steps: TimelineStep[];
  artifactsByStep: Map<string, Artifact[]>;
  outcome?: string;
  pending: PendingCall | null;
  tools: ToolSummary[];
  busy: boolean;
  /** True when the app is running on the live socket. */
  live: boolean;
  onApprove: (pending: PendingCall) => void;
  onReject: (pending: PendingCall) => void;
  onAllowAndRemember: (pending: PendingCall) => void;
  onAnswer?: (requestId: string, answer: string) => void;
  demo?: boolean;
}) {
  return (
    <div className="space-y-6">
      {steps.length > 0 ? (
        <ol className="relative">
          {/* The vertical spine the step dots sit on. */}
          <span
            aria-hidden="true"
            className="absolute left-[13px] top-2 bottom-2 w-px bg-line"
          />
          {steps.map((step) => (
            <Step
              key={step.id}
              step={step}
              artifacts={artifactsByStep.get(step.id) ?? []}
              pending={pending}
              tools={tools}
              busy={busy}
              live={live}
              onApprove={onApprove}
              onReject={onReject}
              onAllowAndRemember={onAllowAndRemember}
              onAnswer={onAnswer}
            />
          ))}
        </ol>
      ) : null}

      {outcome ? (
        <section
          aria-labelledby="outcome-heading"
          className={`rounded-xl border p-4 ${
            demo
              ? 'border-dashed border-warn-line bg-warn-soft'
              : 'border-line bg-surface-raised'
          }`}
        >
          <h3
            id="outcome-heading"
            className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint"
          >
            Outcome
          </h3>
          <div
            aria-live="polite"
            className="mt-2 space-y-2 text-[14px] leading-relaxed text-ink"
          >
            {renderMarkdown(outcome)}
          </div>
        </section>
      ) : null}
    </div>
  );
}
