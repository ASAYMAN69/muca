/**
 * The single API client for Muca's frontend.
 *
 * All calls are relative to the app origin. The Express server hosts the
 * Next.js app and the API on the same port, so `/api/v1/...` resolves
 * without any host, port or environment variable in the browser bundle.
 */

export const API_BASE = '/api/v1';

export interface ToolSummary {
  name: string;
  title: string;
  description: string;
  destructive: boolean;
}

export interface HealthResponse {
  status: string;
  server: { name: string; version: string };
  mcp: { protocolVersion: string; url: string };
  ai: { enabled: boolean; provider: string | null };
  tools: ToolSummary[];
}

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
  | { type: 'error'; message: string };

export interface ChatResponse {
  text: string;
  awaitingConfirmation: boolean;
  pendingCall: {
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    message: string;
  } | null;
  events: AgentEvent[];
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
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
  const body = text ? (JSON.parse(text) as unknown) : null;

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
