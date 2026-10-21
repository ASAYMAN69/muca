'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  MCP_ENDPOINT,
  McpBrowserClient,
  type McpLogEntry,
  type McpSession,
  type McpTool,
} from '../../lib/mcp';

const EMPTY_SESSION: McpSession = {
  status: 'idle',
  tools: [],
  log: [],
};

type CopyState = 'idle' | 'copied' | 'failed';

function StatusDot({ status }: { status: McpSession['status'] }) {
  const tone =
    status === 'connected'
      ? 'bg-emerald-500'
      : status === 'connecting'
        ? 'bg-amber-500 animate-pulse'
        : status === 'failed'
          ? 'bg-red-500'
          : 'bg-neutral-400';
  return <span className={`inline-block size-2 rounded-full ${tone}`} aria-hidden="true" />;
}

function CopyButton({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const [state, setState] = useState<CopyState>('idle');

  const copy = useCallback(() => {
    const write = async () => {
      try {
        await navigator.clipboard.writeText(value);
        setState('copied');
      } catch {
        setState('failed');
      }
    };
    void write();
    window.setTimeout(() => setState('idle'), 1800);
  }, [value]);

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${label}`}
      className="rounded-md border border-neutral-300 px-2 py-1 text-[11px] font-medium text-neutral-600 transition hover:border-neutral-400 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:text-neutral-100"
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
    </button>
  );
}

function ToolRow({ tool }: { tool: McpTool }) {
  return (
    <li className="border-t border-neutral-200 py-2.5 first:border-t-0 dark:border-neutral-800">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <code className="font-mono text-[13px] font-semibold text-neutral-900 dark:text-neutral-100">
          {tool.name}
        </code>
        {tool.destructive ? (
          <span className="rounded-full border border-red-300 bg-red-50 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300">
            destructive
          </span>
        ) : (
          <span className="rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">
            read-only
          </span>
        )}
        {tool.title && tool.title !== tool.name ? (
          <span className="text-[12px] text-neutral-500 dark:text-neutral-400">
            {tool.title}
          </span>
        ) : null}
      </div>
      {tool.description ? (
        <p className="mt-1 text-[12px] leading-relaxed text-neutral-600 dark:text-neutral-400">
          {tool.description}
        </p>
      ) : null}
    </li>
  );
}

function LogLine({ entry }: { entry: McpLogEntry }) {
  const time = entry.at.slice(11, 23);
  const label = entry.method ?? (entry.rpcId !== undefined ? `id ${entry.rpcId}` : 'response');
  const outgoing = entry.direction === 'out';

  return (
    <li className="border-t border-neutral-200 py-2 first:border-t-0 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500">
          {time}
        </span>
        <span
          className={`rounded px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-wide ${
            outgoing
              ? 'bg-neutral-900 text-neutral-50 dark:bg-neutral-100 dark:text-neutral-900'
              : 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
          }`}
        >
          {outgoing ? '→' : '←'}
        </span>
        <span className="font-mono text-[12px] font-medium text-neutral-800 dark:text-neutral-200">
          {label}
        </span>
      </div>
      <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-neutral-50 p-2.5 font-mono text-[11px] leading-relaxed text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
        {entry.payload}
      </pre>
    </li>
  );
}

/**
 * The MCP handshake panel.
 *
 * This is the highest-value surface for the Alexa+ track: it shows a real
 * MCP session, negotiated against our own server, with the raw JSON-RPC
 * traffic. A judge can see protocol compliance without opening devtools.
 */
export function McpPanel({
  health,
  onSessionChange,
}: {
  health: { server?: { name?: string; version?: string }; mcp?: { protocolVersion?: string } } | null;
  onSessionChange?: (session: McpSession) => void;
}) {
  const [session, setSession] = useState<McpSession>(EMPTY_SESSION);
  const [open, setOpen] = useState(false);
  const clientRef = useRef<McpBrowserClient | null>(null);
  const logRef = useRef<HTMLOListElement>(null);

  const apply = useCallback(
    (next: McpSession) => {
      setSession(next);
      onSessionChange?.(next);
    },
    [onSessionChange],
  );

  // Connect on mount so the panel is already live when a judge opens it.
  useEffect(() => {
    const client = new McpBrowserClient((partial) => {
      setSession((prev) => {
        const next = { ...prev, ...partial };
        onSessionChange?.(next);
        return next;
      });
    });
    clientRef.current = client;
    void client.connect();

    return () => {
      void client.dispose();
      clientRef.current = null;
    };
  }, [onSessionChange]);

  // Keep the log pinned to the newest entry.
  useEffect(() => {
    const list = logRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [session.log]);

  const reconnect = useCallback(() => {
    void clientRef.current?.connect();
  }, []);

  const sessionId = session.sessionId;
  const truncatedId = sessionId
    ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`
    : '—';

  return (
    <section
      aria-labelledby="mcp-panel-heading"
      className="rounded-xl border border-neutral-200 bg-white/70 backdrop-blur-sm dark:border-neutral-800 dark:bg-neutral-900/50"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="mcp-panel-body"
          className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:focus-visible:outline-neutral-100"
        >
          <StatusDot status={session.status} />
          <span className="min-w-0">
            <span
              id="mcp-panel-heading"
              className="block text-[13px] font-semibold text-neutral-900 dark:text-neutral-100"
            >
              MCP session
            </span>
            <span className="block truncate text-[11px] text-neutral-500 dark:text-neutral-400">
              {session.status === 'connected'
                ? `Connected · ${session.tools.length} tools · ${truncatedId}`
                : session.status === 'connecting'
                  ? 'Performing the handshake…'
                  : session.status === 'failed'
                    ? 'Handshake failed'
                    : 'Not connected'}
            </span>
          </span>
        </button>

        <span
          aria-live="polite"
          className="shrink-0 rounded-full border border-neutral-200 px-2 py-0.5 font-mono text-[10px] text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
        >
          {session.protocolVersion ??
            health?.mcp?.protocolVersion ??
            '—'}
        </span>
      </div>

      {open ? (
        <div id="mcp-panel-body" className="border-t border-neutral-200 dark:border-neutral-800">
          <div className="space-y-4 px-4 py-4">
            {/* Connection facts */}
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
              <Fact label="Status">
                <span className="flex items-center gap-2">
                  <StatusDot status={session.status} />
                  {session.status}
                </span>
              </Fact>
              <Fact label="Protocol version">
                <code className="font-mono">
                  {session.protocolVersion ??
                    health?.mcp?.protocolVersion ??
                    '—'}
                </code>
              </Fact>
              <Fact label="Server">
                <code className="font-mono">
                  {session.serverInfo?.name ?? health?.server?.name ?? '—'}
                  {session.serverInfo?.version ?? health?.server?.version
                    ? ` v${session.serverInfo?.version ?? health?.server?.version}`
                    : ''}
                </code>
              </Fact>
              <Fact label="Session id">
                <span className="flex items-center gap-2">
                  <code className="font-mono text-[11px]">{truncatedId}</code>
                  {sessionId ? <CopyButton value={sessionId} label="session id" /> : null}
                </span>
              </Fact>
            </dl>

            {session.error ? (
              <p
                role="alert"
                className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
              >
                {session.error}
              </p>
            ) : null}

            {session.status === 'failed' ? (
              <button
                type="button"
                onClick={reconnect}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-900 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
              >
                Retry handshake
              </button>
            ) : null}

            {/* Raw traffic — first, because it is the artefact that
                proves the protocol is real. */}
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                JSON-RPC traffic
                <span className="ml-2 font-normal normal-case tracking-normal">
                  live, over <code className="font-mono">{MCP_ENDPOINT}</code>
                </span>
              </h3>
              {session.log.length > 0 ? (
                <ol
                  ref={logRef}
                  className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50/60 p-2 dark:border-neutral-800 dark:bg-neutral-950/40"
                >
                  {session.log.map((entry) => (
                    <LogLine key={entry.id} entry={entry} />
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-[12px] text-neutral-500 dark:text-neutral-400">
                  The handshake has not produced any traffic yet.
                </p>
              )}
            </div>

            {/* Discovered tools */}
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                Discovered tools
                <span className="ml-2 font-normal normal-case tracking-normal">
                  from <code className="font-mono">tools/list</code>
                </span>
              </h3>
              {session.tools.length > 0 ? (
                <ul className="mt-2 max-h-80 overflow-y-auto pr-1">
                  {session.tools.map((tool) => (
                    <ToolRow key={tool.name} tool={tool} />
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[12px] text-neutral-500 dark:text-neutral-400">
                  Waiting for the tool catalogue…
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[12px] text-neutral-800 dark:text-neutral-200">
        {children}
      </dd>
    </div>
  );
}
