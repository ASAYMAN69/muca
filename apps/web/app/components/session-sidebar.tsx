'use client';

import { useEffect, useRef, useState } from 'react';

import type { SessionSummary } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import type { LiveStatus } from '../../lib/live';

const LIVE_LABEL: Record<LiveStatus, string> = {
  idle: 'not connected',
  connecting: 'connecting…',
  live: 'live',
  reconnecting: 'reconnecting…',
  offline: 'offline',
};

/**
 * The session sidebar.
 *
 * One column, always visible on a wide screen and a sheet on a narrow
 * one. Every row says what it is: the title, when it was last used, and
 * a marker when the agent is waiting for an answer.
 */
export function SessionSidebar({
  sessions,
  currentId,
  onSelect,
  onNew,
  onDemo,
  onOpenPolicies,
  onOpenHelp,
  onRename,
  onDelete,
  liveStatus,
  open,
  onClose,
  sessionsAvailable,
}: {
  sessions: SessionSummary[];
  currentId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  onDemo: () => void;
  onOpenPolicies: () => void;
  onOpenHelp: () => void;
  onRename: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  liveStatus: LiveStatus;
  open: boolean;
  onClose: () => void;
  sessionsAvailable: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  /* The session being renamed, and the one being deleted. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const startRename = (session: SessionSummary) => {
    setConfirmId(null);
    setRenamingId(session.id);
    setDraft(session.title || '');
  };

  const cancelRename = () => {
    setRenamingId(null);
    setDraft('');
  };

  const commitRename = () => {
    const title = draft.trim();
    if (renamingId && title) onRename(renamingId, title);
    cancelRename();
  };

  // While the sheet is open, the page behind it should not scroll and the
  // focus should stay inside.
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

  return (
    <>
      {/* The scrim behind the sheet on a narrow screen. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/50 transition-opacity duration-200 ease-out md:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <aside
        ref={panelRef}
        tabIndex={-1}
        aria-label="Sessions"
        className={`fixed inset-y-0 left-0 z-40 flex w-[280px] flex-col border-r border-line bg-surface-raised outline-none transition-transform duration-200 ease-out md:sticky md:top-0 md:z-auto md:max-h-screen md:w-64 md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* The wordmark */}
        <div className="flex items-baseline justify-between gap-2 px-4 pt-4 pb-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold tracking-tight text-ink">
              Muca
            </span>
            <span className="text-[11px] text-ink-faint">ops copilot</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close the session list"
            className="rounded-md p-1 text-ink-faint transition-colors duration-150 hover:bg-surface-hover hover:text-ink md:hidden"
          >
            <span aria-hidden="true" className="text-[14px] leading-none">
              ✕
            </span>
          </button>
        </div>

        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={onNew}
            className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-[13px] font-medium text-ink transition-[transform,background-color] duration-150 ease-out hover:bg-surface-hover active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden="true" className="text-[15px] leading-none text-accent">
              +
            </span>
            New session
          </button>
        </div>

        {/* The sessions */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2">
          <h2 className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Sessions
          </h2>
          {sessions.length === 0 ? (
            <p className="px-2 py-2 text-[12px] leading-relaxed text-ink-faint">
              {sessionsAvailable
                ? 'No sessions yet. Start one to begin.'
                : 'The server has no session list yet, so this app is running in single-session mode.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((session) => {
                const active = session.id === currentId;
                const waiting = session.waiting === true;
                const renaming = renamingId === session.id;
                const confirming = confirmId === session.id;
                return (
                  <li key={session.id} className="group relative">
                    {renaming ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          commitRename();
                        }}
                        className="px-1 py-1"
                      >
                        <input
                          autoFocus
                          value={draft}
                          aria-label="Session name"
                          placeholder="Name this session"
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') cancelRename();
                          }}
                          className="w-full rounded-md border border-line bg-surface px-2 py-1 text-[13px] text-ink outline-none focus:border-accent"
                        />
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-current={active ? 'page' : undefined}
                          onClick={() => onSelect(session.id)}
                          className={`w-full rounded-lg px-2.5 py-2 pr-16 text-left transition-[background-color,transform] duration-150 ease-out active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                            active
                              ? 'bg-surface-hover text-ink'
                              : 'text-ink-muted hover:bg-surface-hover/60 hover:text-ink'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-[13px]">
                              {session.title || 'Untitled session'}
                            </span>
                            {waiting ? (
                              <span
                                title="The agent is waiting for you"
                                className="flex shrink-0 items-center gap-1 rounded-full bg-warn-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-warn"
                              >
                                <span
                                  aria-hidden="true"
                                  className="size-1.5 rounded-full bg-warn motion-safe:animate-pulse"
                                />
                                needs you
                              </span>
                            ) : null}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-ink-faint">
                            {relativeTime(session.updatedAt ?? session.createdAt)}
                          </span>
                        </button>

                        {/* Rename and delete. Always visible on a narrow
                            screen, on hover on a wide one. */}
                        <div className="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-100 transition-opacity duration-150 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                          {confirming ? (
                            <>
                              <button
                                type="button"
                                autoFocus
                                onClick={() => {
                                  setConfirmId(null);
                                  onDelete(session.id);
                                }}
                                className="rounded-md bg-bad-soft px-1.5 py-0.5 text-[11px] font-semibold text-bad transition-colors duration-150 hover:bg-bad/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bad"
                              >
                                Delete?
                              </button>
                              <button
                                type="button"
                                aria-label="Keep the session"
                                onClick={() => setConfirmId(null)}
                                className="rounded-md p-1 text-[11px] text-ink-faint transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                              >
                                <span aria-hidden="true">✕</span>
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                aria-label={`Rename ${session.title || 'this session'}`}
                                title="Rename"
                                onClick={() => startRename(session)}
                                className="rounded-md p-1 text-[12px] text-ink-faint transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                              >
                                <span aria-hidden="true">✎</span>
                              </button>
                              <button
                                type="button"
                                aria-label={`Delete ${session.title || 'this session'}`}
                                title="Delete"
                                onClick={() => setConfirmId(session.id)}
                                className="rounded-md p-1 text-[12px] text-ink-faint transition-colors duration-150 hover:bg-surface-hover hover:text-bad focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bad"
                              >
                                <span aria-hidden="true">🗑</span>
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* The footer: policies, help, and the live state. */}
        <div className="border-t border-line px-2 py-2">
          <button
            type="button"
            onClick={onDemo}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden="true" className="text-[12px]">
              ▷
            </span>
            Demo
            <span className="ml-auto text-[10px] text-ink-faint">a scripted run</span>
          </button>
          <button
            type="button"
            onClick={onOpenPolicies}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden="true" className="text-[12px]">
              ⚙
            </span>
            Policies
            <span className="ml-auto text-[10px] text-ink-faint">who gets asked</span>
          </button>
          <button
            type="button"
            onClick={onOpenHelp}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] text-ink-muted transition-colors duration-150 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span aria-hidden="true" className="text-[12px]">
              ?
            </span>
            Help
            <span className="ml-auto text-[10px] text-ink-faint">what every control does</span>
          </button>
          <p className="mt-1 px-2.5 text-[10px] uppercase tracking-wider text-ink-faint">
            updates:{' '}
            <span
              className={
                liveStatus === 'live' ? 'text-accent' : 'text-ink-faint'
              }
            >
              {LIVE_LABEL[liveStatus]}
            </span>
          </p>
        </div>
      </aside>
    </>
  );
}
