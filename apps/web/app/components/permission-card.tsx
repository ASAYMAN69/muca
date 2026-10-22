'use client';

import { useEffect, useRef } from 'react';

import type { PendingCall, ToolSummary } from '../../lib/api';
import {
  describeConsequence,
  describeRemembering,
  type ToolFact,
} from '../../lib/consequences';

/**
 * The permission card.
 *
 * It appears in the timeline, where the decision actually happened, and it
 * has to be legible without instruction: what the tool is, what it will
 * run, what will change, why it is asking, and the three answers.
 *
 * Nothing here is a modal. The user is reading a workflow, and the
 * decision belongs inside it.
 */
export function PermissionCard({
  pending,
  tools,
  busy,
  onAllow,
  onDeny,
  onAllowAndRemember,
}: {
  pending: PendingCall;
  tools: ToolSummary[];
  busy: boolean;
  onAllow: (pending: PendingCall) => void;
  onDeny: (pending: PendingCall) => void;
  onAllowAndRemember: (pending: PendingCall) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const tool: ToolFact | undefined = tools.find(
    (candidate) => candidate.name === pending.name,
  );

  const consequence = describeConsequence(tool, pending.arguments ?? {});
  const remembering = describeRemembering(tool, pending.arguments ?? {});
  const reason = pending.reason?.trim();
  const matchedPolicy = pending.matchedPolicy?.trim();

  // After a decision, focus stays near the decision instead of jumping to
  // the top of the page.
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
  }, [pending.callId]);

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="group"
      aria-labelledby={`permission-${pending.callId}`}
      className="overflow-hidden rounded-xl border border-warn-line bg-warn-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warn"
    >
      {/* The header: what is being asked, and how serious it is. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-warn-line/70 px-4 py-2.5">
        <span className="rounded border border-warn-line bg-warn/15 px-1.5 py-px text-[10px] font-bold uppercase tracking-[0.12em] text-warn">
          Consequential
        </span>
        <h4
          id={`permission-${pending.callId}`}
          className="text-[13px] font-semibold text-ink"
        >
          Permission needed
        </h4>
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          {pending.name}
        </span>
      </div>

      <div className="space-y-3 px-4 py-3.5">
        {/* The tool's own title and description. Never the model's prose. */}
        <div>
          <p className="text-[14px] font-medium leading-snug text-ink">
            {pending.title || tool?.title || pending.name}
          </p>
          {pending.description || tool?.description ? (
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
              {pending.description || tool?.description}
            </p>
          ) : null}
        </div>

        {/* What will run. */}
        <div>
          <h5 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            What will run
          </h5>
          <dl className="mt-1.5 divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface-sunken">
            {Object.entries(pending.arguments ?? {}).map(([key, value]) => (
              <div
                key={key}
                className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5"
              >
                <dt className="font-mono text-[11px] text-ink-muted">{key}</dt>
                <dd className="min-w-0 flex-1 break-words font-mono text-[11.5px] text-ink">
                  {typeof value === 'string'
                    ? value
                    : JSON.stringify(value) ?? String(value)}
                </dd>
              </div>
            ))}
            {Object.keys(pending.arguments ?? {}).length === 0 ? (
              <div className="px-3 py-1.5">
                <dd className="font-mono text-[11.5px] text-ink-faint">
                  no arguments
                </dd>
              </div>
            ) : null}
          </dl>
        </div>

        {/* What will change, in a sentence. */}
        <div>
          <h5 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            What will change
          </h5>
          <p className="mt-1 text-[13px] leading-relaxed text-ink">
            {consequence}
          </p>
        </div>

        {/* Why it is asking. */}
        {reason || matchedPolicy ? (
          <div>
            <h5 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Why it is asking
            </h5>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
              {matchedPolicy
                ? `The policy “${matchedPolicy}” asks for this.`
                : reason}
            </p>
          </div>
        ) : null}

        {/* The three answers. */}
        <div className="flex flex-col gap-2 pt-0.5 sm:flex-row sm:items-start">
          <button
            type="button"
            onClick={() => onAllow(pending)}
            disabled={busy}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-[13px] font-semibold text-surface transition-[transform,background-color,opacity] duration-150 ease-out hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            Allow once
          </button>
          <button
            type="button"
            onClick={() => onDeny(pending)}
            disabled={busy}
            className="inline-flex items-center justify-center rounded-lg border border-line px-3.5 py-2 text-[13px] font-medium text-ink-muted transition-[transform,background-color,color] duration-150 ease-out hover:bg-surface-hover hover:text-ink active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onAllowAndRemember(pending)}
            disabled={busy}
            className="inline-flex items-center justify-center rounded-lg border border-line px-3.5 py-2 text-[13px] font-medium text-ink-muted transition-[transform,background-color,color] duration-150 ease-out hover:bg-surface-hover hover:text-ink active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            Allow and remember
          </button>
        </div>
        <p className="text-[11.5px] leading-relaxed text-ink-faint">
          {remembering}
        </p>
      </div>
    </div>
  );
}
