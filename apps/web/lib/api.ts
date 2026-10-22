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
 *
 * Every event that belongs to a tool call carries that call's id in `id`,
 * whatever the server called it on the wire: `confirmation_required` and
 * `approval_decision` arrive as `callId`, and the parser normalises them.
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
      /** The tool's own title, when the server knows it. */
      title?: string;
      /** The tool's own description. Never the model's prose. */
      description?: string;
      /** Why the server is asking: the policy, or "this tool writes". */
      reason?: string;
      /** The policy that produced the decision, if any. */
      matchedPolicy?: string | null;
    }
  | {
      /** The backend reports the decision it recorded for an approval. */
      type: 'approval_decision';
      id: string;
      name: string;
      approved: boolean;
      source?: string;
    }
  | {
      /** The agent needs an answer before it can continue. */
      type: 'clarification';
      id: string;
      question: string;
      options?: string[];
    }
  | {
      /** The user answered the question. */
      type: 'clarification_answered';
      id: string;
      answer: string;
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

  const id = callIdOf(record);
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
        title: typeof record.title === 'string' ? record.title : undefined,
        description:
          typeof record.description === 'string' ? record.description : undefined,
        reason: typeof record.reason === 'string' ? record.reason : undefined,
        matchedPolicy:
          typeof record.matchedPolicy === 'string' ? record.matchedPolicy : null,
      };
    case 'approval_decision':
      return {
        type: 'approval_decision',
        id,
        name,
        approved: record.approved === true,
        source: typeof record.source === 'string' ? record.source : undefined,
      };
    case 'clarification':
      return {
        type: 'clarification',
        id,
        question: asText(record.question),
        options: Array.isArray(record.options)
          ? record.options.filter((option): option is string => typeof option === 'string')
          : undefined,
      };
    case 'clarification_answered':
      return {
        type: 'clarification_answered',
        id,
        answer: asText(record.answer),
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

/**
 * The call id of an event.
 *
 * The server's event union uses **two names for the same thing**: `id` on
 * `tool_call` and `tool_result`, `callId` on `confirmation_required` and
 * `approval_decision`. Both identify the same tool call, so the id is read
 * from `callId` first and falls back to `id`.
 *
 * Getting this wrong is not cosmetic: the timeline folds a tool call into
 * its approval row by matching ids, so an empty id would show the judge two
 * rows for one tool call.
 */
function callIdOf(record: Record<string, unknown>): string {
  if (typeof record.callId === 'string' && record.callId !== '') {
    return record.callId;
  }
  if (typeof record.id === 'string') return record.id;
  return '';
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
  /** The request id, when the server asked over the socket. */
  requestId?: string;
  /** The tool's own title. */
  title?: string;
  /** The tool's own description. */
  description?: string;
  /** Why the server is asking. */
  reason?: string;
  /** The policy that produced the decision, if any. */
  matchedPolicy?: string | null;
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

/** The tool catalogue. Falls back to an empty list when it is missing. */
export async function fetchTools(): Promise<ToolSummary[]> {
  try {
    const response = await request<{ tools?: ToolSummary[] }>('/tools');
    return Array.isArray(response?.tools) ? response.tools : [];
  } catch {
    return [];
  }
}

export function sendChat(
  message: string,
  history: ChatTurn[],
  approvedCallIds: string[] = [],
  sessionId?: string | null,
): Promise<ChatResponse> {
  return request<ChatResponse>('/chat', {
    method: 'POST',
    // The session id tells the server which session the run belongs to,
    // so its events and its permissions land in the session the user is
    // looking at.
    body: JSON.stringify({
      message,
      history,
      approvedCallIds,
      ...(sessionId ? { sessionId } : {}),
    }),
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

/* -------------------------------------------------------------------------- */
/* Sessions                                                                    */
/* -------------------------------------------------------------------------- */

/** A session in the sidebar. */
export interface SessionSummary {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  archived?: boolean;
  /** True when the agent is waiting for this session. */
  waiting?: boolean;
  /** How many requests are waiting. */
  waitingCount?: number;
  /** True while a run is going. */
  active?: boolean;
}

/** A message in a session. */
export interface SessionMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | string;
  content?: string;
  createdAt?: string;
}

/** A request the agent is waiting on: a permission or a question. */
export interface WaitingRequest {
  id: string;
  kind?: 'permission' | 'clarification' | string;
  tool?: string;
  title?: string;
  question?: string;
  createdAt?: string;
}

/** One session, with everything it holds. */
export interface SessionDetail {
  id: string;
  title?: string;
  messages?: SessionMessage[];
  runs?: RunRecord[];
  waiting?: WaitingRequest[];
  updatedAt?: string;
}

export interface SessionsResponse {
  sessions?: SessionSummary[];
}

export interface SessionResponse {
  session?: SessionDetail;
}

export interface CreatedSessionResponse {
  session?: SessionSummary;
}

/**
 * The sessions, newest first.
 *
 * Returns `null` when the route does not exist yet, so the app can tell
 * "no sessions" from "no session list" and fall back to a single local
 * session.
 */
export async function fetchSessions(): Promise<SessionSummary[] | null> {
  try {
    const response = await request<SessionsResponse>('/sessions');
    return Array.isArray(response?.sessions) ? response.sessions : [];
  } catch {
    return null;
  }
}

/** Creates a session. Returns null when the route is not there yet. */
export async function createSession(
  title = '',
): Promise<SessionSummary | null> {
  try {
    const response = await request<CreatedSessionResponse>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    return response?.session ?? null;
  } catch {
    return null;
  }
}

/** One session. Returns null when it is unknown or the route is missing. */
export async function fetchSession(
  sessionId: string,
): Promise<SessionDetail | null> {
  try {
    const response = await request<SessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    return response?.session ?? null;
  } catch {
    return null;
  }
}

/** Renames or archives a session. */
export async function updateSession(
  sessionId: string,
  patch: { title?: string; archived?: boolean },
): Promise<SessionDetail | null> {
  try {
    const response = await request<SessionResponse>(
      `/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    );
    return response?.session ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Policies                                                                    */
/* -------------------------------------------------------------------------- */

/** One policy: a tool, optional argument matchers, and an effect. */
export interface Policy {
  id: string;
  toolName: string;
  /** Argument matchers, e.g. `{ "name": { "startsWith": "fix/" } }`. */
  match?: Record<string, unknown> | null;
  effect: 'allow' | 'ask' | 'deny' | string;
  enabled?: boolean;
  priority?: number;
  label?: string;
  /** Null for a global policy, a session id for a per-session one. */
  sessionId?: string | null;
  createdAt?: string;
}

export interface PoliciesResponse {
  policies?: Policy[];
}

export interface PolicyResponse {
  policy?: Policy;
}

/** The policies, global and per session. */
export async function fetchPolicies(): Promise<Policy[]> {
  try {
    const response = await request<PoliciesResponse>('/policies');
    return Array.isArray(response?.policies) ? response.policies : [];
  } catch {
    return [];
  }
}

/** Creates a policy. Returns null when the route is not there yet. */
export async function createPolicy(
  policy: Omit<Policy, 'id'>,
): Promise<Policy | null> {
  try {
    const response = await request<PolicyResponse>('/policies', {
      method: 'POST',
      body: JSON.stringify(policy),
    });
    return response?.policy ?? null;
  } catch {
    return null;
  }
}

/** Edits a policy. */
export async function updatePolicy(
  policyId: string,
  patch: Partial<Omit<Policy, 'id'>>,
): Promise<Policy | null> {
  try {
    const response = await request<PolicyResponse>(
      `/policies/${encodeURIComponent(policyId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    );
    return response?.policy ?? null;
  } catch {
    return null;
  }
}

/** Deletes a policy. */
export async function deletePolicy(policyId: string): Promise<boolean> {
  try {
    await request(`/policies/${encodeURIComponent(policyId)}`, {
      method: 'DELETE',
    });
    return true;
  } catch {
    return false;
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
