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

/**
 * The MCP session.
 *
 * The browser is a real MCP client: the official SDK's transport speaks
 * to our own endpoint, and the panel shows the handshake that results.
 * The evidence lives in a header pill, so it never dominates the page.
 */
export function useMcpSession(health: {
  server?: { name?: string; version?: string };
  mcp?: { protocolVersion?: string };
} | null): {
  session: McpSession;
  reconnect: () => void;
} {
  const [session, setSession] = useState<McpSession>(EMPTY_SESSION);
  const clientRef = useRef<McpBrowserClient | null>(null);

  const apply = useCallback((next: McpSession) => {
    setSession(next);
  }, []);

  useEffect(() => {
    const client = new McpBrowserClient(apply);
    clientRef.current = client;
    void client.connect();

    return () => {
      void client.dispose();
      clientRef.current = null;
    };
  }, [apply]);

  const reconnect = useCallback(() => {
    void clientRef.current?.connect();
  }, []);

  return { session, reconnect };
}

/** The status pill in the header. One click, and it opens the evidence. */
export function McpStatusPill({
  session,
  health,
  open,
  onToggle,
}: {
  session: McpSession;
  health: { mcp?: { protocolVersion?: string } } | null;
  open: boolean;
  onToggle: () => void;
}) {
  const connected = session.status === 'connected';
  const truncatedId = session.sessionId
    ? `${session.sessionId.slice(0, 8)}…${session.sessionId.slice(-4)}`
    : null;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls="mcp-panel-body"
      title="The live MCP session: protocol, tools and the raw JSON-RPC traffic"
      className="group inline-flex items-center gap-2 rounded-full border border-line bg-surface-raised px-2.5 py-1 text-[11px] text-ink-muted transition-[background-color,color,border-color] duration-150 ease-out hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <StatusDot status={session.status} />
      <span className="font-medium">MCP</span>
      <span className="text-ink-faint">
        {connected
          ? `${session.protocolVersion ?? health?.mcp?.protocolVersion ?? ''} · ${session.tools.length} tools`
          : session.status === 'connecting'
            ? 'handshaking…'
            : session.status === 'failed'
              ? 'failed'
              : 'offline'}
      </span>
      {truncatedId ? (
        <span className="hidden font-mono text-[10px] text-ink-faint sm:inline">
          {truncatedId}
        </span>
      ) : null}
    </button>
  );
}

/** The evidence itself: the handshake, the catalogue, the raw traffic. */
export function McpDetails({
  session,
  health,
  onReconnect,
}: {
  session: McpSession;
  health: {
    server?: { name?: string; version?: string };
    mcp?: { protocolVersion?: string };
  } | null;
  onReconnect: () => void;
}) {
  const logRef = useRef<HTMLOListElement>(null);
  const sessionId = session.sessionId;
  const truncatedId = sessionId
    ? `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`
    : '—';

  // Keep the log pinned to the newest entry.
  useEffect(() => {
    const list = logRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [session.log]);

  return (
    <section
      id="mcp-panel-body"
      aria-label="MCP session evidence"
      className="rounded-xl border border-line bg-surface-raised"
    >
      <div className="space-y-4 px-4 py-4">
        {/* Connection facts */}
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 sm:grid-cols-2">
          <Fact label="Status">
            <span aria-live="polite" className="flex items-center gap-2">
              <StatusDot status={session.status} />
              {session.status}
            </span>
          </Fact>
          <Fact label="Protocol version">
            <code className="font-mono">
              {session.protocolVersion ?? health?.mcp?.protocolVersion ?? '—'}
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
              {sessionId ? (
                <CopyButton value={sessionId} label="session id" />
              ) : null}
            </span>
          </Fact>
        </dl>

        {session.error ? (
          <p
            role="alert"
            className="rounded-lg border border-bad-line bg-bad-soft px-3 py-2 text-[12px] text-bad"
          >
            {session.error}
          </p>
        ) : null}

        {session.status === 'failed' ? (
          <button
            type="button"
            onClick={onReconnect}
            className="rounded-md bg-accent px-3 py-1.5 text-[12px] font-medium text-surface transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Retry handshake
          </button>
        ) : null}

        {/* Raw traffic — first, because it is the artefact that proves the
            protocol is real. */}
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            JSON-RPC traffic
            <span className="ml-2 font-normal normal-case tracking-normal text-ink-muted">
              live, over <code className="font-mono">{MCP_ENDPOINT}</code>
            </span>
          </h3>
          {session.log.length > 0 ? (
            <ol
              ref={logRef}
              className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-line bg-surface-sunken p-2"
            >
              {session.log.map((entry) => (
                <LogLine key={entry.id} entry={entry} />
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-[12px] text-ink-faint">
              The handshake has not produced any traffic yet.
            </p>
          )}
        </div>

        {/* Discovered tools */}
        <div>
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            Discovered tools
            <span className="ml-2 font-normal normal-case tracking-normal text-ink-muted">
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
            <p className="mt-2 text-[12px] text-ink-faint">
              Waiting for the tool catalogue…
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function StatusDot({ status }: { status: McpSession['status'] }) {
  const tone =
    status === 'connected'
      ? 'bg-accent'
      : status === 'connecting'
        ? 'bg-warn motion-safe:animate-pulse'
        : status === 'failed'
          ? 'bg-bad'
          : 'bg-ink-faint';
  return (
    <span className={`inline-block size-2 rounded-full ${tone}`} aria-hidden="true" />
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
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
      className="rounded-md border border-line px-2 py-1 text-[11px] font-medium text-ink-muted transition-[background-color,color,border-color] duration-150 ease-out hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : 'Copy'}
    </button>
  );
}

function ToolRow({ tool }: { tool: McpTool }) {
  return (
    <li className="border-t border-line py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <code className="font-mono text-[13px] font-semibold text-ink">
          {tool.name}
        </code>
        {tool.destructive ? (
          <span className="rounded-full border border-warn-line bg-warn-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-warn">
            destructive
          </span>
        ) : (
          <span className="rounded-full border border-good-line bg-good-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-good">
            read-only
          </span>
        )}
        {tool.title && tool.title !== tool.name ? (
          <span className="text-[12px] text-ink-muted">{tool.title}</span>
        ) : null}
      </div>
      {tool.description ? (
        <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
          {tool.description}
        </p>
      ) : null}
    </li>
  );
}

function LogLine({ entry }: { entry: McpLogEntry }) {
  const time = entry.at.slice(11, 23);
  const label =
    entry.method ?? (entry.rpcId !== undefined ? `id ${entry.rpcId}` : 'response');
  const outgoing = entry.direction === 'out';

  return (
    <li className="border-t border-line py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] tabular-nums text-ink-faint">
          {time}
        </span>
        <span
          className={`rounded px-1.5 py-px font-mono text-[10px] font-semibold uppercase tracking-wide ${
            outgoing
              ? 'bg-ink text-surface'
              : 'bg-good-soft text-good'
          }`}
        >
          {outgoing ? '→' : '←'}
        </span>
        <span className="font-mono text-[12px] font-medium text-ink">{label}</span>
      </div>
      <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-ink-muted">
        {entry.payload}
      </pre>
    </li>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[12px] text-ink">{children}</dd>
    </div>
  );
}
