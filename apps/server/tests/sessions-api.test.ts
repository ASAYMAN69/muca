import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

import { createApiRouter } from '../src/http/api.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { createAskUserTool } from '../src/tools/ask-user.js';
import { MucaStore } from '../src/store/index.js';
import { LiveService } from '../src/live/service.js';
import type { AIProvider, ProviderResponse } from '../src/ai/provider.js';

/** A provider that answers straight away. */
class ChattyProvider implements AIProvider {
  readonly name = 'chatty-provider';

  async chat(): Promise<ProviderResponse> {
    return { content: 'Hello there.', toolCalls: [], finishReason: 'stop' };
  }
}

describe('the session and policy routes', () => {
  let httpServer: Server;
  let baseUrl: string;
  let dir: string;
  let store: MucaStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'muca-sessions-'));
    store = new MucaStore(join(dir, 'muca.db'));

    const registry = new ToolRegistry().registerAll(createTools());
    const liveRegistry = new ToolRegistry().registerAll([
      ...registry.list(),
      createAskUserTool(),
    ]);

    const live = new LiveService({
      store,
      provider: new ChattyProvider(),
      registry,
      liveRegistry,
      systemPrompt: 'You are Muca.',
    });

    const app = express();
    app.use(express.json());
    app.use(
      '/api/v1',
      createApiRouter({
        registry,
        provider: new ChattyProvider(),
        systemPrompt: 'You are Muca.',
        protocolVersion: '2025-11-25',
        mcpUrl: 'http://localhost:8099/api/v1/mcp',
        store,
        live,
      }),
    );

    httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/api/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /tools is unchanged', async () => {
    const response = await fetch(`${baseUrl}/tools`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tools: Array<{ name: string }> };
    expect(body.tools.length).toBeGreaterThan(0);
    // The question tool belongs to the live path only: the MCP surface
    // and the REST catalogue do not change.
    expect(body.tools.some((t) => t.name === 'ask_user')).toBe(false);
  });

  it('POST /sessions creates a session', async () => {
    const response = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Triage' }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      session: { id: string; title: string; messages: unknown[] };
    };
    expect(body.session.id).toMatch(/^ses_/);
    expect(body.session.title).toBe('Triage');
    expect(body.session.messages).toEqual([]);
  });

  it('GET /sessions lists the sessions', async () => {
    const response = await fetch(`${baseUrl}/sessions`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      sessions: Array<{ id: string; title: string }>;
    };
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.sessions.some((s) => s.title === 'Triage')).toBe(true);
  });

  it('GET /sessions/:id returns the session', async () => {
    const created = await (
      await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'One' }),
      })
    ).json() as { session: { id: string } };

    const response = await fetch(`${baseUrl}/sessions/${created.session.id}`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      session: { id: string; title: string; runs: unknown[]; waiting: unknown[] };
    };
    expect(body.session.id).toBe(created.session.id);
    expect(body.session.title).toBe('One');
    expect(Array.isArray(body.session.runs)).toBe(true);
    expect(Array.isArray(body.session.waiting)).toBe(true);
  });

  it('GET /sessions/:id returns 404 for an unknown session', async () => {
    const response = await fetch(`${baseUrl}/sessions/ses_nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('No session with id');
  });

  it('PATCH /sessions/:id renames and archives', async () => {
    const created = await (
      await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Before' }),
      })
    ).json() as { session: { id: string } };

    const response = await fetch(`${baseUrl}/sessions/${created.session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'After', archived: true }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      session: { title: string; archived: boolean };
    };
    expect(body.session.title).toBe('After');
    expect(body.session.archived).toBe(true);
  });

  it('DELETE /sessions/:id removes the session and everything in it', async () => {
    const created = await (
      await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Doomed' }),
      })
    ).json() as { session: { id: string } };
    const id = created.session.id;

    // Give it something to delete.
    await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', sessionId: id }),
    });

    const deleted = await fetch(`${baseUrl}/sessions/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);

    const gone = await fetch(`${baseUrl}/sessions/${id}`);
    expect(gone.status).toBe(404);

    // The rows are gone too, not just the session.
    expect(store.sessions.get(id)).toBeNull();
    expect(store.messages.list(id)).toHaveLength(0);
    expect(store.runs.listForSession(id)).toHaveLength(0);
    expect(store.events.readFrom(id, 0)).toHaveLength(0);
  });

  it('DELETE /sessions/:id is 404 for an unknown session', async () => {
    const response = await fetch(`${baseUrl}/sessions/ses_nope`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(404);
  });

  it('GET /sessions/:id/events replays the event log', async () => {
    const created = await (
      await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Events' }),
      })
    ).json() as { session: { id: string } };

    store.events.appendMany([
      {
        sessionId: created.session.id,
        seq: 1,
        runId: 'run_1',
        type: 'run_started',
        data: { message: 'hi' },
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        sessionId: created.session.id,
        seq: 2,
        runId: 'run_1',
        type: 'message_delta',
        data: { text: 'yo' },
        createdAt: '2026-01-01T00:00:00.001Z',
      },
    ]);

    const response = await fetch(
      `${baseUrl}/sessions/${created.session.id}/events?fromSeq=2`,
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      events: Array<{ seq: number; type: string }>;
      nextSeq: number;
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.seq).toBe(2);
    expect(body.nextSeq).toBe(3);
  });

  /* ---------------------------------------------------------------- */
  /* The policies                                                     */
  /* ---------------------------------------------------------------- */

  it('POST /policies creates a policy', async () => {
    const response = await fetch(`${baseUrl}/policies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        toolName: 'create_branch',
        match: { name: { startsWith: 'fix/' } },
        effect: 'allow',
        label: 'fix branches',
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      policy: {
        id: string;
        toolName: string;
        effect: string;
        match: Record<string, unknown>;
        label: string;
        sessionId: string | null;
      };
    };
    expect(body.policy.id).toMatch(/^pol_/);
    expect(body.policy.toolName).toBe('create_branch');
    expect(body.policy.effect).toBe('allow');
    expect(body.policy.match).toEqual({ name: { startsWith: 'fix/' } });
    expect(body.policy.label).toBe('fix branches');
    expect(body.policy.sessionId).toBeNull();
  });

  it('GET /policies lists them', async () => {
    const response = await fetch(`${baseUrl}/policies`);
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      policies: Array<{ id: string; toolName: string }>;
    };
    expect(body.policies.some((p) => p.toolName === 'create_branch')).toBe(true);
  });

  it('PATCH /policies/:id edits a policy', async () => {
    const created = await (
      await fetch(`${baseUrl}/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'echo', effect: 'ask' }),
      })
    ).json() as { policy: { id: string } };

    const response = await fetch(`${baseUrl}/policies/${created.policy.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ effect: 'deny', enabled: false }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      policy: { effect: string; enabled: boolean };
    };
    expect(body.policy.effect).toBe('deny');
    expect(body.policy.enabled).toBe(false);
  });

  it('DELETE /policies/:id removes a policy', async () => {
    const created = await (
      await fetch(`${baseUrl}/policies`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'echo', effect: 'ask' }),
      })
    ).json() as { policy: { id: string } };

    const response = await fetch(`${baseUrl}/policies/${created.policy.id}`, {
      method: 'DELETE',
    });
    expect(response.status).toBe(200);

    const after = await fetch(`${baseUrl}/policies/${created.policy.id}`, {
      method: 'DELETE',
    });
    expect(after.status).toBe(404);
  });

  it('rejects a policy with an unknown effect', async () => {
    const response = await fetch(`${baseUrl}/policies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolName: 'echo', effect: 'maybe' }),
    });
    expect(response.status).toBe(400);
  });

  /* ---------------------------------------------------------------- */
  /* The live chat path                                               */
  /* ---------------------------------------------------------------- */

  it('POST /chat without a session behaves exactly as before', async () => {
    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello', history: [] }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      text: string;
      awaitingConfirmation: boolean;
      runId: string;
    };
    expect(body.text).toBe('Hello there.');
    expect(body.awaitingConfirmation).toBe(false);
    expect(body.runId).toMatch(/^run_/);
  });

  it('POST /chat with a session runs the run live', async () => {
    const created = await (
      await fetch(`${baseUrl}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Live' }),
      })
    ).json() as { session: { id: string } };

    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'hello',
        history: [],
        sessionId: created.session.id,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      text: string;
      runId: string;
      live: boolean;
    };
    expect(body.live).toBe(true);
    expect(body.runId).toMatch(/^run_/);
    expect(body.text).toBe('Hello there.');

    // The run was flushed to the database.
    const stored = store.runs.get(body.runId);
    expect(stored?.sessionId).toBe(created.session.id);
    expect(stored?.outcome).toBe('completed');
  });
});
