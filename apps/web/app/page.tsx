'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchHealth,
  sendChat,
  type AgentEvent,
  type ChatTurn,
  type HealthResponse,
} from '../lib/api';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  events?: AgentEvent[];
  /** Set when the assistant is blocked on a destructive tool call. */
  pending?: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    message: string;
  } | null;
}

/* -------------------------------------------------------------------------- */
/* Small presentational pieces                                                */
/* -------------------------------------------------------------------------- */

function ToolEvent({ event }: { event: AgentEvent }) {
  if (event.type === 'tool_call') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        <span className="font-mono font-semibold">call</span>
        <span className="font-mono">{event.name}</span>
        <span className="opacity-70">
          {JSON.stringify(event.arguments)}
        </span>
      </div>
    );
  }

  if (event.type === 'tool_result') {
    return (
      <div className="flex items-start gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
        <span className="font-mono font-semibold">result</span>
        <span className="font-mono">{event.name}</span>
        <span className="opacity-80">{event.summary}</span>
      </div>
    );
  }

  if (event.type === 'error') {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
        {event.message}
      </div>
    );
  }

  return null;
}

function ConfirmationPrompt({
  pending,
  onApprove,
  onReject,
  busy,
}: {
  pending: NonNullable<Message['pending']>;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-lg border border-amber-400 bg-amber-50/80 p-4 dark:border-amber-700 dark:bg-amber-950/30">
      <p className="text-sm font-semibold text-amber-900 dark:text-amber-100">
        Confirmation required
      </p>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
        Muca wants to run a consequential action:{' '}
        <span className="font-mono">{pending.message}</span>
      </p>
      <pre className="mt-2 overflow-x-auto rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/10">
        {JSON.stringify(pending.arguments, null, 2)}
      </pre>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={busy}
          className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-50"
        >
          {busy ? 'Running…' : 'Approve & run'}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={busy}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Chat                                                                       */
/* -------------------------------------------------------------------------- */

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch((error: unknown) =>
        setHealthError(
          error instanceof Error ? error.message : 'Could not reach the API',
        ),
      );
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /** Conversation history in the shape the API expects. */
  const history = (): ChatTurn[] =>
    messages
      .filter((m) => m.content.trim().length > 0)
      .map((m) => ({ role: m.role, content: m.content }));

  const run = useCallback(
    async (message: string, approvedCallIds: string[] = []) => {
      setBusy(true);
      try {
        const response = await sendChat(message, history(), approvedCallIds);

        setMessages((prev) => {
          const next = [...prev];

          // When approving, replace the placeholder assistant turn that
          // asked for confirmation with the completed one.
          if (approvedCallIds.length > 0) {
            const last = next[next.length - 1];
            if (last?.pending) {
              next[next.length - 1] = {
                ...last,
                content: response.text || last.content,
                events: response.events,
                pending: null,
              };
              return next;
            }
          }

          next.push({
            id: `m${Date.now()}`,
            role: 'user',
            content: message,
          });
          next.push({
            id: `a${Date.now()}`,
            role: 'assistant',
            content: response.text,
            events: response.events,
            pending: response.pendingCall,
          });
          return next;
        });
      } catch (error) {
        setMessages((prev) => [
          ...prev,
          {
            id: `e${Date.now()}`,
            role: 'assistant',
            content: '',
            events: [
              {
                type: 'error',
                message:
                  error instanceof Error
                    ? error.message
                    : 'Something went wrong talking to the agent.',
              },
            ],
          },
        ]);
      } finally {
        setBusy(false);
      }
    },
    [messages],
  );

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = input.trim();
      if (!trimmed || busy) return;
      setInput('');
      void run(trimmed);
    },
    [busy, input, run],
  );

  const approve = useCallback(
    (pending: NonNullable<Message['pending']>) => {
      void run('yes, go ahead', [pending.callId]);
    },
    [run],
  );

  const reject = useCallback((pending: NonNullable<Message['pending']>) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.pending?.callId === pending.callId
          ? {
              ...m,
              content:
                m.content || 'Okay — I cancelled that action. Let me know what to do instead.',
              pending: null,
            }
          : m,
      ),
    );
  }, []);

  const aiEnabled = health?.ai.enabled ?? false;

  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col px-4 py-8">
      {/* Header */}
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Muca</h1>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          An AI agent that uses MCP tools — Amazon Developer Hackathon 2026,
          Alexa+ track.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {healthError ? (
            <span className="rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
              API unreachable: {healthError}
            </span>
          ) : health ? (
            <>
              <span className="rounded-full border border-neutral-300 px-2.5 py-1 dark:border-neutral-700">
                MCP {health.mcp.protocolVersion}
              </span>
              <span
                className={`rounded-full border px-2.5 py-1 ${
                  aiEnabled
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                }`}
              >
                {aiEnabled ? `AI: ${health.ai.provider}` : 'AI not configured'}
              </span>
              <span className="rounded-full border border-neutral-300 px-2.5 py-1 dark:border-neutral-700">
                {health.tools.length} tools
              </span>
            </>
          ) : (
            <span className="rounded-full border border-neutral-300 px-2.5 py-1 dark:border-neutral-700">
              connecting…
            </span>
          )}
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 space-y-5">
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed border-neutral-300 p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
            <p className="font-medium text-neutral-800 dark:text-neutral-200">
              Try one of these:
            </p>
            <ul className="mt-2 list-inside list-disc space-y-1">
              <li>&ldquo;What is the weather in Dhaka?&rdquo;</li>
              <li>&ldquo;Create a note called Groceries with tag errands&rdquo;</li>
              <li>&ldquo;List my notes&rdquo;</li>
              <li>&ldquo;Delete note 1&rdquo; — this one asks for confirmation</li>
            </ul>
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.role === 'user' ? 'flex justify-end' : 'space-y-2'
            }
          >
            {message.role === 'user' ? (
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-neutral-900 px-4 py-2.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900">
                {message.content}
              </div>
            ) : (
              <>
                {message.events
                  ?.filter((e) => e.type === 'tool_call' || e.type === 'tool_result' || e.type === 'error')
                  .map((event, index) => (
                    <ToolEvent key={`${message.id}-ev-${index}`} event={event} />
                  ))}

                {message.content && (
                  <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-neutral-200 px-4 py-2.5 text-sm leading-relaxed dark:border-neutral-800">
                    {message.content}
                  </div>
                )}

                {message.pending && (
                  <ConfirmationPrompt
                    pending={message.pending}
                    busy={busy}
                    onApprove={() => approve(message.pending!)}
                    onReject={() => reject(message.pending!)}
                  />
                )}
              </>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <form onSubmit={submit} className="sticky bottom-0 mt-6 flex gap-2 bg-white pt-2 dark:bg-neutral-950">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            aiEnabled
              ? 'Ask Muca to do something…'
              : 'Set OPENAI_API_KEY in .env to enable the agent'
          }
          disabled={busy || !aiEnabled}
          className="flex-1 rounded-lg border border-neutral-300 px-4 py-2.5 text-sm outline-none transition focus:border-neutral-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={busy || !aiEnabled || !input.trim()}
          className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {busy ? 'Working…' : 'Send'}
        </button>
      </form>
    </div>
  );
}
