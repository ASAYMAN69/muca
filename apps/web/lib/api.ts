/**
 * The single API client for Muca's frontend.
 *
 * All calls are relative to the app origin. The Express server hosts the
 * Next.js app and the API on the same port, so `/api/v1/...` resolves
 * without any host, port or environment variable in the browser bundle.
 *
 * Every response field is optional. The backend agent is shipping new
 * routes and new fields in parallel, so the client must degrade
 * gracefully when a field is missing rather than crash.
 */

export const API_BASE = '/api/v1';

export interface ToolSummary {
  name: string;
  title: string;
  description: string;
  destructive: boolean;
}

export interface HealthResponse {
  status?: string;
  server?: { name?: string; version?: string };
  mcp?: { protocolVersion?: string; url?: string };
  ai?: { enabled?: boolean; provider?: string | null };
  tools?: ToolSummary[];
}

/**
 * The events a run is made of.
 *
 * The union is closed on purpose: unknown event types are parsed out into
 * a separate list rather than widening the union, so the timeline can
 * narrow each event without casting.
 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; summary: string; data: unknown }
  | {
      type: 'confirmation_required';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
      message: string;
    }
  | {
      /** The backend reports the decision it recorded for an approval. */
      type: 'approval_decision';
      id: string;
      name: string;
      approved: boolean;
      source?: string;
    }
  | { type: 'error'; message: string };

/** The events the client understands, plus the ones it does not. */
export interface ParsedEvents {
  events: AgentEvent[];
  unknown: unknown[];
}

/**
 * Parses the raw `events` array defensively.
 *
 * The backend is adding event types in parallel, so an event we do not
 * recognise is kept (for the raw view) rather than crashing the run.
 */
export function parseAgentEvents(value: unknown): ParsedEvents {
  const events: AgentEvent[] = [];
  const unknown: unknown[] = [];

  if (!Array.isArray(value)) return { events, unknown };

  for (const raw of value) {
    const parsed = parseAgentEvent(raw);
    if (parsed) events.push(parsed);
    else unknown.push(raw);
  }

  return { events, unknown };
}

function parseAgentEvent(raw: unknown): AgentEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string') return null;

  const id = typeof record.id === 'string' ? record.id : '';
  const name = typeof record.name === 'string' ? record.name : '';
  const args = isRecord(record.arguments) ? record.arguments : {};

  switch (type) {
    case 'text':
      return { type: 'text', text: asText(record.text) };
    case 'tool_call':
      return { type: 'tool_call', id, name, arguments: args };
    case 'tool_result':
      return {
        type: 'tool_result',
        id,
        name,
        summary: asText(record.summary),
        data: record.data ?? null,
      };
    case 'confirmation_required':
      return {
        type: 'confirmation_required',
        id,
        name,
        arguments: args,
        message: asText(record.message),
      };
    case 'approval_decision':
      return {
        type: 'approval_decision',
        id,
        name,
        approved: record.approved === true,
        source: typeof record.source === 'string' ? record.source : undefined,
      };
    case 'error':
      return { type: 'error', message: asText(record.message) };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface PendingCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  message: string;
}

export interface ChatResponse {
  text?: string;
  awaitingConfirmation?: boolean;
  pendingCall?: PendingCall | null;
  events?: AgentEvent[];
  /** Present once the backend persists runs. */
  runId?: string;
  /** Present when the run started a long-running MCP task. */
  taskId?: string;
  /** Present when the run produced structured artifacts. */
  artifacts?: unknown[];
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** One tool call recorded on a persisted run. */
export interface RunToolCall {
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
  summary?: string;
  error?: string;
  at?: string;
}

/** One approval decision recorded on a persisted run. */
export interface RunApproval {
  requestId: string;
  toolName: string;
  decision: 'approved' | 'rejected' | 'timed_out' | string;
  source?: string;
  at?: string;
}

/** A run in the session history. The list route returns a summary. */
export interface RunRecord {
  id: string;
  startedAt?: string;
  finishedAt?: string | null;
  userMessage?: string;
  text?: string;
  outcome?: string;
  toolCalls?: RunToolCall[];
  approvals?: RunApproval[];
  taskId?: string | null;
  error?: string | null;
}

export interface RunsResponse {
  runs?: RunRecord[];
}

export interface RunResponse {
  run?: RunRecord;
}

/** The status of a long-running MCP task. */
export interface TaskSnapshot {
  taskId: string;
  status?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  statusMessage?: string;
  result?: unknown;
  error?: string;
}

export interface TaskResponse {
  task?: TaskSnapshot;
}

export interface TasksResponse {
  tasks?: TaskSnapshot[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with status ${response.status}`;
    throw new ApiError(message, response.status);
  }

  return body as T;
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/health');
}

export function sendChat(
  message: string,
  history: ChatTurn[],
  approvedCallIds: string[] = [],
): Promise<ChatResponse> {
  return request<ChatResponse>('/chat', {
    method: 'POST',
    body: JSON.stringify({ message, history, approvedCallIds }),
  });
}

/**
 * The run history. Returns an empty list when the route is not implemented
 * yet, so the UI can treat "no history" and "no history feature" the same.
 */
export async function fetchRuns(limit = 20): Promise<RunRecord[]> {
  try {
    const response = await request<RunsResponse>(`/runs?limit=${limit}`);
    return Array.isArray(response?.runs) ? response.runs : [];
  } catch {
    return [];
  }
}

/** One run. Returns null when the route is missing or the run is unknown. */
export async function fetchRun(runId: string): Promise<RunRecord | null> {
  try {
    const response = await request<RunResponse>(`/runs/${encodeURIComponent(runId)}`);
    return response?.run ?? null;
  } catch {
    return null;
  }
}

/** The status of a long-running task. Returns null when it is unknown. */
export async function fetchTask(taskId: string): Promise<TaskSnapshot | null> {
  try {
    const response = await request<TaskResponse>(`/tasks/${encodeURIComponent(taskId)}`);
    return response?.task ?? null;
  } catch {
    return null;
  }
}
