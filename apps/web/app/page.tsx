'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  fetchHealth,
  parseAgentEvents,
  sendChat,
  type AgentEvent,
  type ChatTurn,
  type HealthResponse,
  type PendingCall,
} from '../lib/api';
import {
  buildArtifact,
  type Artifact,
} from '../lib/artifacts';
import {
  DEMO_APPROVED_EVENTS,
  DEMO_EVENTS,
  DEMO_FINAL_EVENTS,
  DEMO_OUTCOME,
  DEMO_PENDING,
  DEMO_REQUEST,
} from '../lib/demo';
import { buildTimeline, type TimelineStep } from '../lib/timeline';
import { McpPanel } from './components/mcp-panel';
import { TimelineView } from './components/timeline';

/* -------------------------------------------------------------------------- */
/* Local state                                                                 */
/* -------------------------------------------------------------------------- */

interface Run {
  id: string;
  /** The user's request. */
  request: string;
  /** Every event of the run, in order. */
  events: AgentEvent[];
  /** The events the client did not understand. */
  unknownEvents?: unknown[];
  /** The approval the run is parked on, if any. */
  pending: PendingCall | null;
  /** True when the run is waiting for the user. */
  awaitingConfirmation: boolean;
  /** The final assistant text. */
  text: string;
  /** The run id reported by the server. */
  runId?: string;
  /** True for the scripted demo run. */
  demo?: boolean;
  /** True when the user declined the pending call. */
  declined?: boolean;
}

let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `run-${runCounter}`;
}

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

export default function Home() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch((cause: unknown) => {
        setHealthError(
          cause instanceof Error ? cause.message : 'Could not reach the API',
        );
      });
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [runs, busy]);

  const aiEnabled = health?.ai?.enabled === true;

  /** The tools the server marked destructive, for the timeline badges. */
  const destructiveTools = useMemo(() => {
    const names = new Set<string>();
    for (const tool of health?.tools ?? []) {
      if (tool?.destructive) names.add(tool.name);
    }
    return names;
  }, [health]);

  /** The conversation history the API expects. */
  const history = useCallback((): ChatTurn[] => {
    const turns: ChatTurn[] = [];
    for (const run of runs) {
      if (run.request.trim()) {
        turns.push({ role: 'user', content: run.request });
      }
      if (run.text.trim()) {
        turns.push({ role: 'assistant', content: run.text });
      }
    }
    return turns;
  }, [runs]);

  /** Runs the agent and appends the result. */
  const runAgent = useCallback(
    async (message: string, approvedCallIds: string[] = []) => {
      setBusy(true);
      setError(null);
      try {
        const response = await sendChat(message, history(), approvedCallIds);
        const { events, unknown } = parseAgentEvents(response.events);
        const text = typeof response.text === 'string' ? response.text : '';
        const pending = response.pendingCall ?? null;

        setRuns((previous) => {
          // When approving, the previous run continues. The server replays
          // the whole run, so the events are replaced rather than appended
          // — otherwise every step would appear twice.
          if (approvedCallIds.length > 0) {
            const last = previous[previous.length - 1];
            if (last?.pending) {
              const next = [...previous];
              next[next.length - 1] = {
                ...last,
                events,
                unknownEvents: unknown,
                text,
                pending,
                awaitingConfirmation: pending !== null,
                runId: response.runId ?? last.runId,
                declined: false,
              };
              return next;
            }
          }

          return [
            ...previous,
            {
              id: nextRunId(),
              request: message,
              events,
              unknownEvents: unknown,
              text,
              pending,
              awaitingConfirmation: pending !== null,
              runId: response.runId,
            },
          ];
        });
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : 'Something went wrong.';
        setError(message);
        setRuns((previous) => [
          ...previous,
          {
            id: nextRunId(),
            request: message,
            events: [{ type: 'error', message }],
            pending: null,
            awaitingConfirmation: false,
            text: '',
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [history],
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = input.trim();
      if (!trimmed || busy) return;
      setInput('');
      void runAgent(trimmed);
    },
    [busy, input, runAgent],
  );

  const approve = useCallback(
    (pending: PendingCall) => {
      void runAgent('yes, go ahead', [pending.callId]);
    },
    [runAgent],
  );

  /** Cancelling sends nothing. The rejection is recorded locally. */
  const reject = useCallback((pending: PendingCall) => {
    setRuns((previous) =>
      previous.map((run) =>
        run.pending?.callId === pending.callId
          ? {
              ...run,
              pending: null,
              awaitingConfirmation: false,
              declined: true,
              events: [
                ...run.events,
                {
                  type: 'approval_decision',
                  id: pending.callId,
                  name: pending.name,
                  approved: false,
                  source: 'http',
                },
              ],
            }
          : run,
      ),
    );
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Demo mode                                                              */
  /* ---------------------------------------------------------------------- */

  const startDemo = useCallback(() => {
    setError(null);
    setRuns((previous) => [
      ...previous,
      {
        id: nextRunId(),
        request: DEMO_REQUEST,
        events: DEMO_EVENTS,
        pending: DEMO_PENDING,
        awaitingConfirmation: true,
        text: '',
        demo: true,
      },
    ]);
  }, []);

  const demoApprove = useCallback((pending: PendingCall) => {
    setRuns((previous) =>
      previous.map((run) => {
        if (!run.demo || run.pending?.callId !== pending.callId) return run;

        // The demo advances one step at a time. Each approval appends the
        // events for that decision and parks the next one.
        if (pending.callId === 'demo-call-3') {
          return {
            ...run,
            events: [...run.events, ...DEMO_APPROVED_EVENTS],
            pending: {
              callId: 'demo-call-4',
              name: 'open_pull_request',
              arguments: {
                title: 'fix: load customer before charging the card in checkout',
                body: 'Loads the customer before charging the card, plus a regression test.',
                branch: 'fix/checkout-missing-customer',
                baseBranch: 'main',
              },
              message:
                'Open pull request (title="fix: load customer before charging the card in checkout", branch="fix/checkout-missing-customer", baseBranch="main")',
            },
            awaitingConfirmation: true,
          };
        }

        if (pending.callId === 'demo-call-4') {
          return {
            ...run,
            events: [...run.events, ...DEMO_FINAL_EVENTS],
            pending: null,
            awaitingConfirmation: false,
            text: DEMO_OUTCOME,
          };
        }

        return run;
      }),
    );
  }, []);

  const demoReject = useCallback((pending: PendingCall) => {
    setRuns((previous) =>
      previous.map((run) =>
        run.demo && run.pending?.callId === pending.callId
          ? {
              ...run,
              pending: null,
              awaitingConfirmation: false,
              declined: true,
              events: [
                ...run.events,
                {
                  type: 'approval_decision',
                  id: pending.callId,
                  name: pending.name,
                  approved: false,
                  source: 'http',
                },
              ],
            }
          : run,
      ),
    );
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Render                                                                 */
  /* ---------------------------------------------------------------------- */

  const hasRuns = runs.length > 0;

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:flex-row lg:gap-8 lg:py-10">
        {/* ------------------------------------------------------------- */}
        {/* Main column                                                     */}
        {/* ------------------------------------------------------------- */}
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="mb-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h1 className="text-[22px] font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
                Muca
              </h1>
              <span className="text-[13px] text-neutral-500 dark:text-neutral-400">
                Ops Copilot — a self-hosted MCP server
              </span>
            </div>
            <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-400">
              An agent that triages deployment and CI failures across your
              services and — only with your approval — opens a branch and a
              pull request. Every tool call below travels over the Model
              Context Protocol.
            </p>
          </header>

          {/* Status strip */}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
            {healthError ? (
              <Chip tone="failed">API unreachable: {healthError}</Chip>
            ) : health ? (
              <>
                <Chip tone="neutral">
                  MCP {health.mcp?.protocolVersion ?? '—'}
                </Chip>
                <Chip tone={aiEnabled ? 'success' : 'warn'}>
                  {aiEnabled
                    ? `AI: ${health.ai?.provider ?? 'enabled'}`
                    : 'AI not configured'}
                </Chip>
                <Chip tone="neutral">
                  {health.tools?.length ?? 0} tools
                </Chip>
              </>
            ) : (
              <Chip tone="neutral">connecting…</Chip>
            )}
          </div>

          {/* Error banner */}
          {error ? (
            <div
              role="alert"
              className="mt-4 flex items-start justify-between gap-3 rounded-lg border border-red-300 bg-red-50 px-3.5 py-3 text-[13px] text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
            >
              <span>{error}</span>
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                className="shrink-0 rounded px-1.5 font-semibold leading-none hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-700 dark:hover:bg-red-900/50 dark:focus-visible:outline-red-300"
              >
                ✕
              </button>
            </div>
          ) : null}

          {/* Demo mode banner */}
          {!aiEnabled && health && !healthError ? (
            <DemoBanner onStart={startDemo} busy={busy} />
          ) : null}

          {/* Empty state */}
          {!hasRuns ? (
            <EmptyState
              aiEnabled={aiEnabled}
              onDemo={startDemo}
              onPick={(text) => setInput(text)}
            />
          ) : null}
          {/* The runs */}
          {hasRuns ? (
            <div className="mt-6 space-y-10">
              {runs.map((run) => (
                <RunView
                  key={run.id}
                  run={run}
                  destructiveTools={destructiveTools}
                  busy={busy}
                  onApprove={run.demo ? demoApprove : approve}
                  onReject={run.demo ? demoReject : reject}
                />
              ))}
            </div>
          ) : null}

          <div ref={endRef} />

          {/* Composer */}
          <form
            onSubmit={submit}
            className="sticky bottom-0 mt-6 flex gap-2 bg-neutral-50/95 pb-2 pt-3 backdrop-blur-sm dark:bg-neutral-950/95"
          >
            <label htmlFor="composer" className="sr-only">
              Ask Muca to do something
            </label>
            <input
              id="composer"
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={
                aiEnabled
                  ? 'Ask Muca to triage a failure…'
                  : 'The AI provider is not configured — use demo mode'
              }
              disabled={busy || !aiEnabled}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3.5 py-2.5 text-[14px] text-neutral-900 outline-none transition placeholder:text-neutral-400 focus:border-neutral-500 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500 dark:focus:border-neutral-500"
            />
            <button
              type="submit"
              disabled={busy || !aiEnabled || !input.trim()}
              className="shrink-0 rounded-lg bg-neutral-900 px-4 py-2.5 text-[13px] font-semibold text-white transition hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 disabled:opacity-40 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:focus-visible:outline-neutral-50"
            >
              {busy ? 'Working…' : 'Send'}
            </button>
          </form>
        </main>

        {/* ------------------------------------------------------------- */}
        {/* Side column: the MCP handshake                                  */}
        {/* ------------------------------------------------------------- */}
        <aside className="w-full shrink-0 lg:w-96">
          <div className="lg:sticky lg:top-6">
            <McpPanel health={health} />
          </div>
        </aside>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* One run                                                                     */
/* -------------------------------------------------------------------------- */

function RunView({
  run,
  destructiveTools,
  busy,
  onApprove,
  onReject,
}: {
  run: Run;
  destructiveTools: Set<string>;
  busy: boolean;
  onApprove: (pending: PendingCall) => void;
  onReject: (pending: PendingCall) => void;
}) {
  const timeline = useMemo(
    () =>
      buildTimeline({
        events: run.events,
        // While the run is parked on an approval, the model's prose is
        // preamble, not the outcome. The outcome is the answer that
        // arrives once the run completes.
        text: run.awaitingConfirmation ? undefined : run.text,
        pendingCall: run.pending,
        awaitingConfirmation: run.awaitingConfirmation,
        runId: run.runId,
        destructiveTools,
        unknownEvents: run.unknownEvents,
      }),
    [run, destructiveTools],
  );

  /** Attach the artifact cards to the evidence steps. */
  const artifactsByStep = useMemo(() => {
    const map = new Map<string, Artifact[]>();
    for (const [index, event] of run.events.entries()) {
      if (event.type !== 'tool_result') continue;
      const artifact = buildArtifact({
        id: `${run.id}-artifact-${index}`,
        toolName: event.name,
        data: event.data,
      });
      if (!artifact) continue;
      const stepId = `s-evidence-${event.id || index}`;
      const list = map.get(stepId) ?? [];
      list.push(artifact);
      map.set(stepId, list);
    }
    return map;
  }, [run.events, run.id]);

  return (
    <section aria-label="Run">
      {/* The request — the loudest thing in the run. */}
      <div className="border-l-2 border-neutral-900 pl-4 dark:border-neutral-100">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
            Request
          </h2>
          {run.demo ? (
            <span className="rounded-full border border-amber-400 bg-amber-50 px-2 py-px text-[10px] font-bold uppercase tracking-wide text-amber-800 dark:border-amber-700 dark:bg-amber-950/50 dark:text-amber-200">
              demo — scripted, not a live run
            </span>
          ) : null}
          {run.runId ? (
            <code className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
              {run.runId}
            </code>
          ) : null}
        </div>
        <p className="mt-1.5 text-[15px] font-medium leading-relaxed text-neutral-900 dark:text-neutral-100">
          {run.request}
        </p>
      </div>

      {/* The timeline */}
      <div className="mt-6">
        <h2 className="text-[10px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          Timeline
        </h2>
        <div className="mt-3">
          <TimelineView
            steps={timeline.steps}
            artifactsByStep={artifactsByStep}
            outcome={timeline.outcome}
            pending={run.pending}
            busy={busy}
            onApprove={onApprove}
            onReject={onReject}
            demo={run.demo}
          />
        </div>
      </div>

      {run.declined ? (
        <p className="mt-2 rounded-lg border border-neutral-200 bg-neutral-100 px-3.5 py-2.5 text-[12px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          You declined that action. Nothing was run.
        </p>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Small pieces                                                                */
/* -------------------------------------------------------------------------- */

function Chip({
  tone,
  children,
}: {
  tone: 'neutral' | 'success' | 'warn' | 'failed';
  children: React.ReactNode;
}) {
  const tones = {
    neutral:
      'border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400',
    success:
      'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    warn: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    failed:
      'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300',
  } as const;

  return (
    <span
      className={`rounded-full border px-2.5 py-0.5 font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function DemoBanner({
  onStart,
  busy,
}: {
  onStart: () => void;
  busy: boolean;
}) {
  return (
    <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50/70 p-4 dark:border-amber-700 dark:bg-amber-950/25">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="rounded border border-amber-400 bg-amber-100 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-200">
          Demo mode
        </span>
        <h2 className="text-[14px] font-semibold text-amber-950 dark:text-amber-100">
          The AI provider is not configured
        </h2>
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-amber-900/90 dark:text-amber-100/90">
        No API key, so the agent itself cannot run. Everything else is live:
        the MCP session, the tool catalogue and the raw JSON-RPC traffic on
        the right are real. The demo below replays a scripted triage run
        through the same timeline, including the approval gate.
      </p>
      <button
        type="button"
        onClick={onStart}
        disabled={busy}
        className="mt-3 rounded-lg bg-amber-600 px-3.5 py-2 text-[13px] font-semibold text-white transition hover:bg-amber-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 disabled:opacity-50 dark:focus-visible:outline-amber-400"
      >
        Run the demo
      </button>
    </div>
  );
}

function EmptyState({
  aiEnabled,
  onDemo,
  onPick,
}: {
  aiEnabled: boolean;
  onDemo: () => void;
  onPick: (text: string) => void;
}) {
  const prompts = [
    'Which deployments failed for checkout-api?',
    'Find the cause of the failing CI run and open a fix PR — ask me first.',
    'List the open issues for payments-worker.',
  ];

  return (
    <div className="mt-6 rounded-xl border border-dashed border-neutral-300 p-5 dark:border-neutral-800">
      <h2 className="text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
        {aiEnabled ? 'Try a run' : 'See how a run works'}
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-neutral-600 dark:text-neutral-400">
        {aiEnabled
          ? 'Muca will show every tool call, the evidence it found and the outcome as a timeline.'
          : 'The demo replays a scripted triage run so you can see the timeline, the evidence cards and the approval gate.'}
      </p>

      <ul className="mt-3 space-y-1.5">
        {prompts.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => (aiEnabled ? onPick(prompt) : onDemo())}
              className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-[13px] text-neutral-700 transition hover:border-neutral-400 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:border-neutral-800 dark:bg-neutral-900/50 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:text-neutral-100 dark:focus-visible:outline-neutral-50"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>

      {/* The demo is always one click away, so a judge can see the flow
          even when a real key is configured. */}
      {aiEnabled ? (
        <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onDemo}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-400 bg-amber-50 px-3 py-1.5 text-[13px] font-medium text-amber-900 transition hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-700 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-900/40 dark:focus-visible:outline-amber-400"
          >
            <span className="rounded border border-amber-400 bg-amber-100 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-amber-800 dark:border-amber-700 dark:bg-amber-900/50 dark:text-amber-200">
              demo
            </span>
            Replay a scripted run (no API key needed)
          </button>
        </div>
      ) : null}
    </div>
  );
}
