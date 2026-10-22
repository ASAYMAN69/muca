'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createPolicy,
  createSession,
  deletePolicy,
  deleteSession,
  fetchHealth,
  fetchPolicies,
  fetchSession,
  fetchSessions,
  fetchTask,
  fetchTools,
  parseAgentEvents,
  sendChat,
  updatePolicy,
  type AgentEvent,
  type ChatTurn,
  type HealthResponse,
  type PendingCall,
  type Policy,
  type SessionSummary,
  type TaskSnapshot,
  type ToolSummary,
  updateSession,
} from '../lib/api';
import { buildArtifact, type Artifact } from '../lib/artifacts';
import {
  DEMO_APPROVED_EVENTS,
  DEMO_EVENTS,
  DEMO_FINAL_EVENTS,
  DEMO_OUTCOME,
  DEMO_PENDING,
  DEMO_REQUEST,
} from '../lib/demo';
import { deriveTitle } from '../lib/format';
import { LiveClient, type LiveFrame, type LiveStatus } from '../lib/live';
import { applyFrame, emptyRun, type LiveRunState } from '../lib/live-run';
import { buildTimeline, type TimelineStep } from '../lib/timeline';
import { HelpPanel } from './components/help-panel';
import { McpDetails, McpStatusPill, useMcpSession } from './components/mcp-panel';
import { PoliciesView } from './components/policies-view';
import { SessionSidebar } from './components/session-sidebar';
import { ThinkingRow } from './components/thinking-row';
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
  /** The long-running MCP task this run started, if any. */
  taskId?: string;
  /** The latest snapshot of that task. */
  task?: TaskSnapshot | null;
  /** True for the scripted demo run. */
  demo?: boolean;
  /** True when the user declined the pending call. */
  declined?: boolean;
  /** The model's reasoning, while it is streaming. */
  thinking?: string;
  /** True while the thinking row is live. */
  thinkingActive?: boolean;
  /** The question the run is parked on. */
  clarificationId?: string;
  /** The tool call that is running and has not answered yet. */
  openCallId?: string;
  /** Permission request id -> the tool call it belongs to. */
  requests?: Record<string, string>;
}

type View = 'timeline' | 'policies';

let runCounter = 0;

function nextRunId(): string {
  runCounter += 1;
  return `run-${runCounter}`;
}

/** The task statuses that mean the task will not change again. */
const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

function isTerminalTaskStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_TASK_STATUSES.includes(status);
}

/** A local session, for when the server has no session list yet. */
function localSessionId(): string {
  return `local-${Math.random().toString(36).slice(2, 10)}`;
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
  const [tools, setTools] = useState<ToolSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  /* Sessions */
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsAvailable, setSessionsAvailable] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  /**
   * The live session id.
   *
   * The state is not enough: a callback can close over a session list
   * that has not caught up yet, and then it would create a second
   * session for a session that already exists. The ref is always
   * current.
   */
  const sessionIdRef = useRef<string | null>(null);
  const setActiveSession = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setSessionId(id);
  }, []);

  /* The shell */
  const [view, setView] = useState<View>('timeline');
  const [helpOpen, setHelpOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);

  /* The live socket */
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('idle');
  const liveRef = useRef<LiveClient | null>(null);
  const framesRef = useRef<(frame: LiveFrame) => void>(() => undefined);
  const [decisionsInFlight, setDecisionsInFlight] = useState<string[]>([]);

  /* Policies */
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policiesAvailable, setPoliciesAvailable] = useState(true);

  const { session: mcpSession, reconnect: reconnectMcp } = useMcpSession(health);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Task ids whose route 404'd (or returned nothing): stop polling them. */
  const unavailableTasks = useRef<Set<string>>(new Set());

  const aiEnabled = health?.ai?.enabled === true;
  const liveMode = liveStatus === 'live';
  const destructiveTools = useDestructiveTools(health, mcpSession.tools);

  /* ---------------------------------------------------------------------- */
  /* Bootstrap                                                               */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch((cause: unknown) => {
        setHealthError(
          cause instanceof Error ? cause.message : 'Could not reach the API',
        );
      });
    void fetchTools().then(setTools);
  }, []);

  /* The sessions. The route may not exist yet: then the app runs in a
     single local session and says so. */
  useEffect(() => {
    let cancelled = false;
    void fetchSessions().then((list) => {
      if (cancelled) return;
      if (list === null) {
        // The server has no session list yet: one local session.
        setSessionsAvailable(false);
        setActiveSession(sessionIdRef.current ?? localSessionId());
        return;
      }
      setSessions(list);
      setActiveSession(sessionIdRef.current ?? list[0]?.id ?? localSessionId());
    });
    return () => {
      cancelled = true;
    };
  }, [setActiveSession]);

  /* The policies. The route may not exist yet either. */
  useEffect(() => {
    let cancelled = false;
    void fetchPolicies().then((list) => {
      if (cancelled) return;
      setPolicies(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [runs, busy]);

  /**
   * The view and the help panel live in the URL, so a link can point at
   * them and the browser's back button behaves.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wantedView = params.get('view') === 'policies' ? 'policies' : null;
    const wantedHelp = params.get('help') === '1';
    if (!wantedView && !wantedHelp) return;
    // After the first paint, so the markup the server sent and the first
    // client render agree.
    const timer = window.setTimeout(() => {
      if (wantedView) setView(wantedView);
      if (wantedHelp) setHelpOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (view === 'policies') params.set('view', 'policies');
    else params.delete('view');
    if (helpOpen) params.set('help', '1');
    else params.delete('help');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      query ? `?${query}` : window.location.pathname,
    );
  }, [view, helpOpen]);

  /* ---------------------------------------------------------------------- */
  /* Sessions                                                                */
  /* ---------------------------------------------------------------------- */

  const refreshSession = useCallback(async (id: string) => {
    const detail = await fetchSession(id);
    if (!detail) return;
    setSessions((current) =>
      current.map((session) =>
        session.id === id
          ? { ...session, title: detail.title ?? session.title }
          : session,
      ),
    );
  }, []);

  /* ---------------------------------------------------------------------- */
  /* The live socket                                                         */
  /* ---------------------------------------------------------------------- */

  /** Applies one frame from the server to the run it belongs to. */
  const handleFrame = useCallback((frame: LiveFrame) => {
    setRuns((previous) => {
      if (frame.type === 'run_started') {
        const data = (frame.data ?? {}) as { message?: string };
        const runId = frame.runId;
        // A frame with no run id cannot be placed. It used to invent one,
        // which put a second copy of the same request in the timeline.
        if (!runId) return previous;

        const existingIndex = previous.findIndex((run) => run.runId === runId);
        if (existingIndex !== -1) {
          const next = [...previous];
          const state = applyFrame(emptyRun(runId), frame);
          const current = next[existingIndex];
          next[existingIndex] = {
            ...current,
            events: current.events.length > 0 ? current.events : state.events,
            pending: state.pending ?? current.pending,
            awaitingConfirmation:
              state.awaitingConfirmation || current.awaitingConfirmation,
            text: state.text || current.text,
            thinking: state.thinking || current.thinking,
            thinkingActive: current.thinkingActive,
          };
          return next;
        }

        // The request was already shown the moment it was sent, as a
        // local placeholder. This frame is the same run, so the
        // placeholder becomes the run instead of joining it.
        const message = (data.message ?? '').trim();
        const placeholderIndex = previous.findIndex(
          (run) =>
            !run.runId &&
            run.events.length === 0 &&
            run.request.trim() === message,
        );

        const state = applyFrame(emptyRun(runId), frame);
        const merged: Run = {
          ...(placeholderIndex !== -1 ? previous[placeholderIndex] : null),
          id: runId,
          runId,
          request:
            placeholderIndex !== -1 && previous[placeholderIndex].request
              ? previous[placeholderIndex].request
              : message,
          events: state.events,
          pending: state.pending,
          awaitingConfirmation: state.awaitingConfirmation,
          text: state.text,
          thinking: state.thinking,
          thinkingActive: state.thinkingActive,
          clarificationId: state.clarification?.id,
        };

        const next = [...previous];
        if (placeholderIndex !== -1) next[placeholderIndex] = merged;
        else next.push(merged);
        return next;
      }

      const index = previous.findIndex(
        (run) => frame.runId !== null && run.runId === frame.runId,
      );
      if (index === -1) return previous;

      const run = previous[index];
      const state: LiveRunState = applyFrame(
        {
          events: run.events,
          text: run.text,
          thinking: run.thinking ?? '',
          thinkingActive: run.thinkingActive ?? false,
          pending: run.pending,
          clarification: run.clarificationId
            ? { id: run.clarificationId, question: '' }
            : null,
          awaitingConfirmation: run.awaitingConfirmation,
          openCallId: run.openCallId,
          requests: run.requests ?? {},
          runId: run.runId,
          toolCallCount: 0,
          approvalCount: 0,
          status: 'running',
        },
        frame,
      );

      const next = [...previous];
      next[index] = {
        ...run,
        events: state.events,
        text: state.text,
        thinking: state.thinking,
        thinkingActive: state.thinkingActive,
        pending: state.pending,
        awaitingConfirmation: state.awaitingConfirmation,
        clarificationId: state.clarification?.id,
        openCallId: state.openCallId,
        requests: state.requests,
      };
      return next;
    });

    // A decision that has been answered is no longer in flight.
    if (frame.type === 'permission_resolved') {
      const data = (frame.data ?? {}) as { requestId?: string };
      if (data.requestId) {
        setDecisionsInFlight((current) =>
          current.filter((id) => id !== data.requestId),
        );
      }
    }
  }, []);

  useEffect(() => {
    framesRef.current = handleFrame;
  }, [handleFrame]);

  useEffect(() => {
    if (!sessionId) return;
    const client = new LiveClient({
      sessionId,
      onFrame: (frame) => framesRef.current(frame),
      onStatus: (status) => setLiveStatus(status),
      onGap: () => {
        // Frames are missing and cannot be replayed: refetch the session.
        void refreshSession(sessionId);
      },
    });
    liveRef.current = client;
    client.connect();
    return () => {
      client.close();
      liveRef.current = null;
    };
  }, [sessionId, refreshSession]);

  /* ---------------------------------------------------------------------- */
  /* Sessions                                                                */
  /* ---------------------------------------------------------------------- */

  const selectSession = useCallback((id: string) => {
    setActiveSession(id);
    setRuns([]);
    setView('timeline');
    setSidebarOpen(false);
  }, [setActiveSession]);

  const newSession = useCallback(async () => {
    const created = await createSession('');
    if (created) {
      setSessions((current) => [created, ...current]);
      setActiveSession(created.id);
    } else {
      const local: SessionSummary = {
        id: localSessionId(),
        title: 'New session',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setSessions((current) => [local, ...current]);
      setSessionId(local.id);
    }
    setRuns([]);
    setView('timeline');
    setSidebarOpen(false);
  }, [setActiveSession]);

  /** Renames a session, in the sidebar and in the store. */
  const renameSession = useCallback((id: string, title: string) => {
    void (async () => {
      const updated = await updateSession(id, { title });
      if (!updated) return;
      setSessions((current) =>
        current.map((session) =>
          session.id === id
            ? {
                ...session,
                title: updated.title ?? title,
                updatedAt: updated.updatedAt ?? session.updatedAt,
              }
            : session,
        ),
      );
    })();
  }, []);

  /**
   * Deletes a session.
   *
   * Deleting the session you are looking at starts a fresh one, so the
   * page is never left pointing at something that is gone.
   */
  const deleteSessionById = useCallback(
    (id: string) => {
      void (async () => {
        const deleted = await deleteSession(id);
        if (!deleted) return;
        setSessions((current) => current.filter((session) => session.id !== id));
        if (sessionIdRef.current === id) {
          setRuns([]);
          setView('timeline');
          setActiveSession(null);
          await newSession();
        }
      })();
    },
    [newSession, setActiveSession],
  );

  /* ---------------------------------------------------------------------- */
  /* Running the agent                                                       */
  /* ---------------------------------------------------------------------- */

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

  const runAgent = useCallback(
    async (message: string, approvedCallIds: string[] = []) => {
      setBusy(true);
      setError(null);

      // The first message creates the session. Until the server has one,
      // the run would belong to a local id it has never heard of, and
      // none of it - the events, the messages, the history - would be
      // persisted or shown in the sidebar.
      let target = sessionIdRef.current;
      if (!target || !sessions.some((session) => session.id === target)) {
        const created = await createSession('');
        if (created) {
          target = created.id;
          setActiveSession(created.id);
          setSessions((current) => [created, ...current]);
        }
      }

      const localId = nextRunId();
      setRuns((previous) => [
        ...previous,
        {
          id: localId,
          request: message,
          events: [],
          pending: null,
          awaitingConfirmation: false,
          text: '',
        },
      ]);
      try {
        const response = await sendChat(message, history(), approvedCallIds, target);
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
                taskId: response.taskId ?? last.taskId,
                declined: false,
              };
              return next;
            }
          }

          // The live socket may already have shown this run. If it has,
          // its frames are the richer record, so they win, and the local
          // placeholder this request created is dropped.
          const liveIndex = response.runId
            ? previous.findIndex((run) => run.runId === response.runId)
            : -1;
          if (liveIndex !== -1) {
            const next = previous.filter((run) => run.id !== localId);
            const index = next.findIndex(
              (run) => run.runId === response.runId,
            );
            if (index !== -1) {
              const live = next[index];
              next[index] = {
                ...live,
                request: live.request || message,
                events: live.events.length > 0 ? live.events : events,
                unknownEvents: unknown,
                text: live.text || text,
                pending: pending ?? live.pending,
                awaitingConfirmation: pending !== null,
                runId: response.runId ?? live.runId,
                taskId: response.taskId ?? live.taskId,
              };
            }
            return next;
          }

          const next = [...previous];
          const index = next.findIndex((run) => run.id === localId);
          const target = index === -1 ? next.length - 1 : index;
          next[target] = {
            ...next[target],
            events,
            unknownEvents: unknown,
            text,
            pending,
            awaitingConfirmation: pending !== null,
            runId: response.runId,
            taskId: response.taskId,
            task: null,
          };
          return next;
        });

        // Name the session after the first message, if the server did not.
        // The name goes to the server too: a local-only title is lost on
        // the next reload, and the sidebar would say "Untitled session".
        if (sessionId && response.runId) {
          const title = deriveTitle(message);
          setSessions((current) =>
            current.map((session) =>
              session.id === sessionId && !session.title
                ? { ...session, title }
                : session,
            ),
          );
          void updateSession(sessionId, { title }).then((updated) => {
            if (updated?.title) {
              setSessions((current) =>
                current.map((session) =>
                  session.id === sessionId ? { ...session, title: updated.title! } : session,
                ),
              );
            }
          });
        }
      } catch (cause) {
        const message =
          cause instanceof Error ? cause.message : 'Something went wrong.';
        setError(message);
        setRuns((previous) =>
          previous.map((run) =>
            run.id === localId
              ? {
                  ...run,
                  events: [{ type: 'error', message }],
                  pending: null,
                  awaitingConfirmation: false,
                }
              : run,
          ),
        );
      } finally {
        setBusy(false);
      }
    },
    [history, sessionId, sessions, setActiveSession],
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

  /* ---------------------------------------------------------------------- */
  /* Decisions                                                               */
  /* ---------------------------------------------------------------------- */

  const decide = useCallback(
    (pending: PendingCall, decision: 'allow' | 'deny', remember = false) => {
      const requestId = pending.requestId ?? pending.callId;
      if (liveMode && liveRef.current) {
        setDecisionsInFlight((current) => [...current, requestId]);
        const sent = liveRef.current.send({
          type: 'decide',
          requestId,
          decision,
          remember,
        });
        if (sent) return;
        setDecisionsInFlight((current) =>
          current.filter((id) => id !== requestId),
        );
      }

      if (decision === 'allow') {
        void runAgent('yes, go ahead', [pending.callId]);
        return;
      }

      // Deny. Cancelling sends nothing; the rejection is recorded locally.
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
    },
    [liveMode, runAgent],
  );

  const approve = useCallback(
    (pending: PendingCall) => decide(pending, 'allow'),
    [decide],
  );

  const reject = useCallback(
    (pending: PendingCall) => decide(pending, 'deny'),
    [decide],
  );

  const allowAndRemember = useCallback(
    (pending: PendingCall) => decide(pending, 'allow', true),
    [decide],
  );

  /** Answers a question the agent asked. */
  const answer = useCallback((requestId: string, text: string) => {
    if (liveRef.current && liveMode) {
      liveRef.current.send({ type: 'answer', requestId, text });
      return;
    }
    void runAgent(text);
  }, [liveMode, runAgent]);

  /* ---------------------------------------------------------------------- */
  /* The demo                                                                */
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
                body: 'Loads the customer first, plus a regression test.',
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
  /* Policies                                                                */
  /* ---------------------------------------------------------------------- */

  const createPolicyAction = useCallback(
    (policy: {
      toolName: string;
      match: Record<string, unknown> | null;
      effect: 'allow' | 'ask' | 'deny';
      label: string;
      sessionId: string | null;
    }) => {
      void createPolicy(policy).then((created) => {
        if (created) {
          setPolicies((current) => [created, ...current]);
          setPoliciesAvailable(true);
        } else {
          setError('The server did not accept the policy.');
        }
      });
    },
    [],
  );

  const updatePolicyAction = useCallback(
    (policyId: string, patch: Partial<Policy>) => {
      setPolicies((current) =>
        current.map((policy) =>
          policy.id === policyId ? { ...policy, ...patch } : policy,
        ),
      );
      void updatePolicy(policyId, patch);
    },
    [],
  );

  const deletePolicyAction = useCallback((policyId: string) => {
    setPolicies((current) => current.filter((policy) => policy.id !== policyId));
    void deletePolicy(policyId);
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Task polling                                                            */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const active = runs.find(
      (run) =>
        run.taskId &&
        !unavailableTasks.current.has(run.taskId) &&
        !isTerminalTaskStatus(run.task?.status),
    );
    if (!active?.taskId) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      void fetchTask(active.taskId!).then((task) => {
        if (cancelled) return;
        if (!task) {
          unavailableTasks.current.add(active.taskId!);
          return;
        }
        setRuns((previous) =>
          previous.map((run) =>
            run.id === active.id ? { ...run, task } : run,
          ),
        );
      });
    }, 1500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runs]);

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  const hasRuns = runs.length > 0;

  // Prefer the catalogue the MCP session actually discovered over the
  // snapshot in `/health`; the MCP panel is the source of truth.
  const toolCount =
    mcpSession.status === 'connected'
      ? mcpSession.tools.length
      : (health?.tools?.length ?? 0);

  const currentSession = sessions.find((session) => session.id === sessionId);

  return (
    <div className="flex min-h-screen bg-surface text-ink">
      <SessionSidebar
        sessions={sessions}
        currentId={sessionId}
        onSelect={selectSession}
        onNew={() => void newSession()}
        onDemo={startDemo}
        onOpenPolicies={() => {
          setView('policies');
          setSidebarOpen(false);
        }}
        onOpenHelp={() => {
          setHelpOpen(true);
          setSidebarOpen(false);
        }}
        onRename={renameSession}
        onDelete={deleteSessionById}
        liveStatus={liveStatus}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        sessionsAvailable={sessionsAvailable}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ------------------------------------------------------------- */}
        {/* The header                                                       */}
        {/* ------------------------------------------------------------- */}
        <header className="sticky top-0 z-20 border-b border-line bg-surface/85 backdrop-blur-md">
          <div className="flex items-center gap-2 px-4 py-2.5 sm:px-6">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open the session list"
              className="rounded-lg border border-line p-1.5 text-ink-muted transition-[background-color,color] duration-150 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent md:hidden"
            >
              <span aria-hidden="true" className="text-[13px] leading-none">
                ☰
              </span>
            </button>

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[14px] font-semibold tracking-tight text-balance text-ink">
                {view === 'policies'
                  ? 'Policies'
                  : (currentSession?.title || 'Muca')}
              </h1>
              <p className="truncate text-[11px] text-ink-faint">
                {view === 'policies'
                  ? 'when the agent has to ask'
                  : 'Muca · ops copilot · every tool call travels over MCP'}
              </p>
            </div>

            <McpStatusPill
              session={mcpSession}
              health={health}
              open={mcpOpen}
              onToggle={() => setMcpOpen((value) => !value)}
            />

            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              aria-label="Open the help panel"
              className="rounded-lg border border-line px-2 py-1 text-[12px] text-ink-muted transition-[background-color,color] duration-150 hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              ?
            </button>
          </div>

          {/* The state strip */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 text-[11px] sm:px-6">
            <span className="text-ink-faint">
              updates:{' '}
              <span className={liveMode ? 'text-accent' : 'text-ink-muted'}>
                {liveMode
                  ? 'live, over the socket'
                  : liveStatus === 'reconnecting'
                    ? 'reconnecting…'
                    : liveStatus === 'offline'
                      ? 'socket unavailable — one request at a time'
                      : 'one request at a time'}
              </span>
            </span>
            {healthError ? (
              <span className="text-bad">API unreachable: {healthError}</span>
            ) : health ? (
              <>
                <span className="text-ink-faint">MCP {health.mcp?.protocolVersion ?? '—'}</span>
                <span className={aiEnabled ? 'text-ink-faint' : 'text-warn'}>
                  {aiEnabled ? `AI: ${health.ai?.provider ?? 'enabled'}` : 'AI not configured'}
                </span>
                <span className="text-ink-faint">{toolCount} tools</span>
              </>
            ) : (
              <span className="text-ink-faint">connecting…</span>
            )}
          </div>
        </header>

        {/* ------------------------------------------------------------- */}
        {/* The content                                                     */}
        {/* ------------------------------------------------------------- */}
        <main id="timeline" className="min-w-0 flex-1 px-4 py-5 sm:px-6">
          {view === 'policies' ? (
            <PoliciesView
              policies={policies}
              tools={tools}
              available={policiesAvailable}
              sessionId={sessionId}
              onCreate={createPolicyAction}
              onUpdate={updatePolicyAction}
              onDelete={deletePolicyAction}
              onBack={() => setView('timeline')}
            />
          ) : (
            <div className="mx-auto max-w-3xl">
              {/* The MCP evidence, on demand. */}
              {mcpOpen ? (
                <div className="mb-6">
                  <McpDetails
                    session={mcpSession}
                    health={health}
                    onReconnect={reconnectMcp}
                  />
                </div>
              ) : null}

              {/* The live region: the one thing a screen reader must not
                  miss is that the agent is waiting for an answer. */}
              <p className="sr-only" role="status" aria-live="polite">
                {runs.find((run) => run.pending)
                  ? `The agent needs permission to run ${runs.find((run) => run.pending)?.pending?.name ?? 'a tool'}.`
                  : ''}
              </p>

              {/* The error banner */}
              {error ? (
                <div
                  role="alert"
                  className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-bad-line bg-bad-soft px-3.5 py-3 text-[13px] text-bad"
                >
                  <span>{error}</span>
                  <button
                    type="button"
                    onClick={() => setError(null)}
                    aria-label="Dismiss error"
                    className="shrink-0 rounded px-1 font-semibold leading-none transition-colors duration-150 hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    ✕
                  </button>
                </div>
              ) : null}

              {/* The demo banner */}
              {!aiEnabled && health && !healthError ? (
                <DemoBanner onStart={startDemo} busy={busy} />
              ) : null}

              {/* The empty state. When the AI provider is off, the demo
                  banner above already explains the situation and offers the
                  demo; a second card of prompts that can only replay that
                  same demo would just be noise. */}
              {!hasRuns && (aiEnabled || !health) ? (
                <EmptyState
                  aiEnabled={aiEnabled}
                  onDemo={startDemo}
                  onPick={(text) => setInput(text)}
                />
              ) : null}

              {/* The runs */}
              {hasRuns ? (
                <div className="space-y-10">
                  {runs.map((run) => (
                    <RunView
                      key={run.id}
                      run={run}
                      tools={tools}
                      destructiveTools={destructiveTools}
                      busy={busy || decisionsInFlight.length > 0}
                      live={liveMode}
                      onApprove={run.demo ? demoApprove : approve}
                      onReject={run.demo ? demoReject : reject}
                      onAllowAndRemember={allowAndRemember}
                      onAnswer={answer}
                    />
                  ))}
                </div>
              ) : null}

              <div ref={endRef} />
            </div>
          )}
        </main>

        {/* ------------------------------------------------------------- */}
        {/* The composer                                                     */}
        {/* ------------------------------------------------------------- */}
        {view === 'timeline' ? (
          <form
            onSubmit={submit}
            className="sticky bottom-0 border-t border-line bg-surface/90 px-4 py-3 backdrop-blur-md sm:px-6"
          >
            <div className="mx-auto flex max-w-3xl gap-2">
              <label htmlFor="composer" className="sr-only">
                Ask Muca to do something
              </label>
              <input
                id="composer"
                name="message"
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
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface-raised px-3.5 py-2.5 text-[14px] text-ink transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-ink-faint focus:border-accent disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={busy || !aiEnabled || !input.trim()}
                className="shrink-0 rounded-lg bg-accent px-4 py-2.5 text-[13px] font-semibold text-surface transition-[filter,transform,opacity] duration-150 ease-out hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
              >
                {busy ? 'Working…' : 'Send'}
              </button>
            </div>
          </form>
        ) : null}
      </div>

      <HelpPanel
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        tools={tools}
        liveMode={liveMode}
      />
    </div>
  );
}

/** The tools the server marked destructive, for the timeline badges. */
function useDestructiveTools(
  health: HealthResponse | null,
  mcpTools: { name: string; destructive: boolean }[],
): Set<string> {
  return useMemo(() => {
    const names = new Set<string>();
    for (const tool of health?.tools ?? []) {
      if (tool?.destructive) names.add(tool.name);
    }
    // The MCP catalogue is the source of truth; `/health` can lag behind it.
    for (const tool of mcpTools) {
      if (tool?.destructive) names.add(tool.name);
    }
    return names;
  }, [health, mcpTools]);
}

/* -------------------------------------------------------------------------- */
/* One run                                                                     */
/* -------------------------------------------------------------------------- */

function RunView({
  run,
  tools,
  destructiveTools,
  busy,
  live,
  onApprove,
  onReject,
  onAllowAndRemember,
  onAnswer,
}: {
  run: Run;
  tools: ToolSummary[];
  destructiveTools: Set<string>;
  busy: boolean;
  live: boolean;
  onApprove: (pending: PendingCall) => void;
  onReject: (pending: PendingCall) => void;
  onAllowAndRemember: (pending: PendingCall) => void;
  onAnswer?: (requestId: string, answer: string) => void;
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
        inFlightCallIds: run.openCallId ? [run.openCallId] : [],
        unknownEvents: run.unknownEvents,
      }),
    [run, destructiveTools],
  );

  /** Attach the artifact cards to the evidence steps. */
  const artifactsByStep = useMemo(() => {
    const map = new Map<string, Artifact[]>();
    for (const step of timeline.steps) {
      if (step.kind !== 'evidence') continue;
      const artifact = buildArtifact({
        id: step.id,
        toolName: step.toolName ?? '',
        data: step.data,
      });
      if (artifact) map.set(step.id, [artifact]);
    }
    return map;
  }, [timeline.steps]);

  return (
    <section aria-label={run.request || 'A run'}>
      {/* The request */}
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-2 h-full w-px shrink-0 bg-line"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Request
            {run.runId ? (
              <span className="ml-2 font-mono font-normal normal-case tracking-normal">
                {run.runId}
              </span>
            ) : null}
            {run.demo ? (
              <span className="ml-2 rounded border border-warn-line bg-warn-soft px-1.5 py-px font-semibold uppercase tracking-wide text-warn">
                demo — scripted, not a live run
              </span>
            ) : null}
          </p>
          <p className="mt-1 text-[15px] font-medium leading-relaxed text-ink">
            {run.request}
          </p>
        </div>
      </div>

      {/* The timeline */}
      <div className="mt-4">
        {run.thinking ? (
          <div className="mb-3">
            <ThinkingRow
              text={run.thinking}
              active={run.thinkingActive === true}
            />
          </div>
        ) : null}
        <TimelineView
          steps={timeline.steps}
          artifactsByStep={artifactsByStep}
          outcome={timeline.outcome}
          pending={run.pending}
          tools={tools}
          busy={busy}
          live={live}
          onApprove={onApprove}
          onReject={onReject}
          onAllowAndRemember={onAllowAndRemember}
          onAnswer={onAnswer}
          demo={run.demo}
        />
      </div>

      {run.declined ? (
        <p className="mt-2 rounded-lg border border-line bg-surface-raised px-3.5 py-2.5 text-[12px] text-ink-muted">
          You declined that action. Nothing was run.
        </p>
      ) : null}

      {run.task ? <TaskStatus status={run.task} /> : null}
    </section>
  );
}

/** The status of a long-running MCP task. */
function TaskStatus({ status }: { status: TaskSnapshot }) {
  const terminal = isTerminalTaskStatus(status.status);
  const tone = terminal
    ? status.status === 'failed'
      ? 'border-bad-line bg-bad-soft text-bad'
      : 'border-good-line bg-good-soft text-good'
    : 'border-warn-line bg-warn-soft text-warn';

  return (
    <p
      aria-live="polite"
      className={`mt-3 rounded-lg border px-3.5 py-2.5 text-[12px] ${tone}`}
    >
      <span className="font-semibold uppercase tracking-[0.12em]">
        Task {status.status ?? 'unknown'}
      </span>
      {status.statusMessage ? (
        <span className="ml-2">{status.statusMessage}</span>
      ) : null}
      {status.taskId ? (
        <code className="ml-2 font-mono text-[11px] opacity-80">
          {status.taskId}
        </code>
      ) : null}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Small pieces                                                                */
/* -------------------------------------------------------------------------- */

function DemoBanner({ onStart, busy }: { onStart: () => void; busy: boolean }) {
  return (
    <section className="mb-6 rounded-xl border border-warn-line bg-warn-soft p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-warn">
        Demo mode
      </p>
      <h2 className="mt-1 text-[15px] font-semibold text-ink">
        The AI provider is not configured
      </h2>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
        No API key, so the agent itself cannot run. Everything else is
        live: the MCP session, the tool catalogue and the raw JSON-RPC
        traffic are real. The demo below replays a scripted triage run
        through the same timeline, including the approval gate.
      </p>
      <button
        type="button"
        onClick={onStart}
        disabled={busy}
        className="mt-3 inline-flex items-center gap-2 rounded-lg bg-warn px-3.5 py-2 text-[13px] font-semibold text-surface transition-[filter,transform,opacity] duration-150 ease-out hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      >
        Run the demo
      </button>
    </section>
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
    <div className="mt-6 rounded-xl border border-dashed border-line p-5">
      <h2 className="text-[13px] font-semibold text-ink">
        {aiEnabled ? 'Try a run' : 'See how a run works'}
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
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
              className="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-left text-[13px] text-ink-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-surface-hover hover:text-ink active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>

      {/* The demo is always one click away, so a judge can see the flow
          even when a real key is configured. */}
      {aiEnabled ? (
        <div className="mt-4 border-t border-line pt-3">
          <button
            type="button"
            onClick={onDemo}
            className="inline-flex items-center gap-2 rounded-lg border border-warn-line bg-warn-soft px-3 py-1.5 text-[13px] font-medium text-ink transition-[background-color,transform] duration-150 ease-out hover:bg-warn/20 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <span className="rounded border border-warn-line bg-warn/20 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-warn">
              demo
            </span>
            Replay a scripted run (no API key needed)
          </button>
        </div>
      ) : null}
    </div>
  );
}
