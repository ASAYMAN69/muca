'use client';

import { useEffect, useRef } from 'react';

import type { ToolSummary } from '../../lib/api';

/**
 * The help panel.
 *
 * A document, not a tooltip. It explains what Muca is, what every control
 * does, what every tool does, and what the approval system is for. It is
 * one click away from anywhere, and it is the only place a first-time
 * user has to look.
 */
export function HelpPanel({
  open,
  onClose,
  tools,
  liveMode,
}: {
  open: boolean;
  onClose: () => void;
  tools: ToolSummary[];
  liveMode: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/45 motion-safe:animate-[fade-in_150ms_ease-out]"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-heading"
        tabIndex={-1}
        className="relative flex h-full w-full max-w-[520px] flex-col border-l border-line bg-surface-raised shadow-[var(--shadow-panel)] outline-none motion-safe:animate-[slide-in_220ms_var(--ease-out)]"
      >
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2
            id="help-heading"
            className="text-[15px] font-semibold tracking-tight text-balance text-ink"
          >
            How Muca works
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the help panel"
            className="rounded-md p-1.5 text-ink-faint transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden="true" className="text-[14px] leading-none">
              ✕
            </span>
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-7 overflow-y-auto overscroll-contain px-5 py-5 text-[13px] leading-relaxed text-ink-muted">
          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              What this is
            </h3>
            <p className="mt-2 text-ink">
              Muca is an operations agent. It reads your deployments, CI runs
              and issues through the Model Context Protocol, works out what
              broke, and asks you before it changes anything.
            </p>
            <p className="mt-2">
              It can read everything your tools expose and it can propose
              changes: a branch, a pull request, an issue, a comment. It
              cannot merge, deploy or delete anything, it cannot work
              without an AI provider, and it has no access to your cloud
              account beyond the tools listed below.
            </p>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Every control
            </h3>
            <dl className="mt-2 space-y-3">
              <Control
                name="New session"
                detail="Starts an empty conversation. The old session stays in the list, and the agent forgets nothing you have already done."
              />
              <Control
                name="A session in the list"
                detail="Switches to that conversation. The socket for the old session closes and a new one opens, so nothing from the previous session leaks into this one."
              />
              <Control
                name="“needs you”"
                detail="The agent is waiting for you in that session. Click it to go there and answer."
              />
              <Control
                name="Policies"
                detail="Decides when the agent has to ask. A policy can allow, ask or deny a tool, optionally only for certain arguments."
              />
              <Control
                name="Help"
                detail="This document."
              />
              <Control
                name="The MCP pill in the header"
                detail="The live proof that the tool protocol is really in use. Click it to see the session id, the tool catalogue and the raw JSON-RPC traffic."
              />
              <Control
                name="The composer"
                detail="Where you ask. Press Enter to send. The agent answers in the timeline, not in a chat bubble."
              />
              <Control
                name="Allow once / Deny / Allow and remember"
                detail="The answer to a permission request. “Allow once” runs this call and asks again next time. “Allow and remember” writes a policy so it stops asking."
              />
              <Control
                name="Show arguments / Show raw result"
                detail="The exact arguments a tool was called with, and the unedited result it returned."
              />
            </dl>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              The tools
            </h3>
            {tools.length === 0 ? (
              <p className="mt-2">
                The tool catalogue is not available right now. Muca reads it
                from the server when it starts.
              </p>
            ) : (
              <ul className="mt-2 space-y-2">
                {tools.map((tool) => (
                  <li
                    key={tool.name}
                    className="rounded-lg border border-line bg-surface px-3 py-2"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="font-mono text-[12px] text-ink">
                        {tool.name}
                      </span>
                      {tool.title ? (
                        <span className="text-[12px] text-ink-muted">
                          {tool.title}
                        </span>
                      ) : null}
                      <span
                        className={`ml-auto rounded-full border px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide ${
                          tool.destructive
                            ? 'border-warn-line bg-warn-soft text-warn'
                            : 'border-line text-ink-faint'
                        }`}
                      >
                        {tool.destructive ? 'writes' : 'read only'}
                      </span>
                    </div>
                    {tool.description ? (
                      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
                        {tool.description}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Why it asks
            </h3>
            <p className="mt-2">
              Muca never decides on its own whether a change is safe. The
              server checks the tool against the policies first:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>
                A tool that only reads is allowed without asking.
              </li>
              <li>
                A tool that writes is asked about, unless a policy covers it.
              </li>
              <li>
                A policy that denies stops the call outright; the agent
                continues and explains what it would have done.
              </li>
            </ul>
            <p className="mt-2">
              The card shows you the exact arguments and a plain sentence
              about what will change, so the answer is never a guess.
            </p>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              When it asks you something
            </h3>
            <p className="mt-2">
              A run that needs you keeps waiting. You can answer now, or
              leave the session and come back later: the request stays in
              the sidebar, marked “needs you”, and the answer is picked up
              when you get there. Answering a question is a normal part of
              the work, not an error.
            </p>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              How to read the timeline
            </h3>
            <ul className="mt-2 space-y-1.5">
              <li>
                <span className="text-ink">The request</span> is what you
                asked, at the top.
              </li>
              <li>
                <span className="text-ink">Tool rows</span> appear the
                moment the agent calls a tool, with the arguments it used.
              </li>
              <li>
                <span className="text-ink">Evidence cards</span> are what
                the tool found: deployments, a failing CI run, a pull
                request.
              </li>
              <li>
                <span className="text-ink">A permission card</span> is a
                decision waiting for you.
              </li>
              <li>
                <span className="text-ink">The outcome</span> is the
                answer, at the bottom.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
              This build
            </h3>
            <p className="mt-2">
              Updates arrive{' '}
              {liveMode ? (
                <span className="text-ink">over the live socket</span>
              ) : (
                <span className="text-ink">
                  one request at a time: the live socket is not available,
                  so Muca falls back to asking and waiting
                </span>
              )}
              . Dark is the default theme.{' '}
              <a
                href="?theme=light"
                className="text-accent underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Switch to the light theme
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function Control({ name, detail }: { name: string; detail: string }) {
  return (
    <div>
      <dt className="text-[12.5px] font-medium text-ink">{name}</dt>
      <dd className="mt-0.5 text-[12.5px] leading-relaxed">{detail}</dd>
    </div>
  );
}
