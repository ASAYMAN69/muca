import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MucaStore } from '../src/store/index.js';

/**
 * The database.
 *
 * The tests use a temporary file, never the user's real one: the store
 * takes its path as a parameter for exactly this reason.
 */
describe('the database', () => {
  let dir: string;
  let store: MucaStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muca-db-'));
    store = new MucaStore(join(dir, 'muca.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file and the directory it lives in', () => {
    const nested = new MucaStore(join(dir, 'deep', 'deeper', 'muca.db'));
    expect(nested.path).toContain('muca.db');
    nested.close();
  });

  it('creates every table of the protocol', () => {
    const tables = (
      store.database.handle
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all() as unknown as Array<{ name: string }>
    ).map((row) => row.name);

    for (const table of [
      'sessions',
      'messages',
      'events',
      'runs',
      'approvals',
      'requests',
      'policies',
    ]) {
      expect(tables, `${table} is missing`).toContain(table);
    }
  });

  it('opens the same file again without losing anything', () => {
    store.sessions.create({ id: 'ses_1', title: 'Triage' });
    store.close();

    const reopened = new MucaStore(join(dir, 'muca.db'));
    expect(reopened.sessions.get('ses_1')?.title).toBe('Triage');
    reopened.close();

    // The `afterEach` closes it again; that is harmless.
    store = new MucaStore(join(dir, 'muca.db'));
  });

  describe('the sessions', () => {
    it('creates, reads and lists them', () => {
      const session = store.sessions.create({ title: 'First' });
      expect(session.id).toMatch(/^ses_/);
      expect(store.sessions.get(session.id)?.title).toBe('First');

      store.sessions.create({ title: 'Second' });
      const list = store.sessions.list();
      expect(list.length).toBe(2);
    });

    it('renames and archives them', () => {
      const session = store.sessions.create({ title: 'Before' });
      expect(store.sessions.rename(session.id, 'After')?.title).toBe('After');
      expect(store.sessions.setArchived(session.id, true)?.archived).toBe(true);
      expect(store.sessions.list().some((s) => s.id === session.id)).toBe(false);
      expect(
        store.sessions.list({ includeArchived: true }).some((s) => s.id === session.id),
      ).toBe(true);
    });

    it('returns null for an unknown session', () => {
      expect(store.sessions.get('ses_nope')).toBeNull();
    });
  });

  describe('the messages', () => {
    it('appends them in order and never reorders them', () => {
      store.sessions.create({ id: 'ses_1' });
      store.messages.append({ sessionId: 'ses_1', role: 'user', content: 'one' });
      store.messages.append({ sessionId: 'ses_1', role: 'assistant', content: 'two' });
      store.messages.append({ sessionId: 'ses_1', role: 'user', content: 'three' });

      const messages = store.messages.list('ses_1');
      expect(messages.map((m) => m.content)).toEqual(['one', 'two', 'three']);
      expect(messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    });

    it('keeps the sequences of two sessions apart', () => {
      store.messages.append({ sessionId: 'ses_a', role: 'user', content: 'a' });
      store.messages.append({ sessionId: 'ses_b', role: 'user', content: 'b' });
      store.messages.append({ sessionId: 'ses_a', role: 'user', content: 'a2' });

      expect(store.messages.list('ses_a').map((m) => m.content)).toEqual(['a', 'a2']);
      expect(store.messages.list('ses_b').map((m) => m.content)).toEqual(['b']);
    });
  });

  describe('the events', () => {
    it('stores them per session, in sequence order', () => {
      store.events.appendMany([
        { sessionId: 'ses_1', seq: 1, runId: 'run_1', type: 'run_started', data: { a: 1 }, createdAt: '2026-01-01T00:00:00.000Z' },
        { sessionId: 'ses_1', seq: 2, runId: 'run_1', type: 'message_delta', data: { text: 'hi' }, createdAt: '2026-01-01T00:00:00.001Z' },
      ]);

      const events = store.events.readFrom('ses_1', 0);
      expect(events.map((e) => e.seq)).toEqual([1, 2]);
      expect(events[0]?.data).toEqual({ a: 1 });
      expect(store.events.maxSeq('ses_1')).toBe(2);
    });

    it('reads a range', () => {
      for (let seq = 1; seq <= 10; seq += 1) {
        store.events.append({
          sessionId: 'ses_1',
          seq,
          type: 'message_delta',
          data: { seq },
        });
      }

      const range = store.events.readRange('ses_1', 3, 6);
      expect(range.map((e) => e.seq)).toEqual([3, 4, 5, 6]);
    });

    it('never stores the same sequence twice', () => {
      store.events.append({ sessionId: 'ses_1', seq: 1, type: 'a', data: {} });
      store.events.append({ sessionId: 'ses_1', seq: 1, type: 'b', data: {} });

      const events = store.events.readFrom('ses_1', 0);
      expect(events.length).toBe(1);
      expect(events[0]?.type).toBe('a');
    });
  });

  describe('the runs', () => {
    it('records how a run ended', () => {
      store.runs.start({ id: 'run_1', sessionId: 'ses_1' });
      expect(store.runs.get('run_1')?.finishedAt).toBeNull();

      store.runs.finish({
        id: 'run_1',
        outcome: 'completed',
        toolCallCount: 2,
        approvalCount: 1,
      });

      const run = store.runs.get('run_1');
      expect(run?.outcome).toBe('completed');
      expect(run?.toolCallCount).toBe(2);
      expect(run?.approvalCount).toBe(1);
      expect(run?.finishedAt).toBeTruthy();
    });
  });

  describe('the approvals and the requests', () => {
    it('records a permission and its decision', () => {
      store.approvals.request({
        id: 'apr_1',
        sessionId: 'ses_1',
        requestId: 'req_1',
        toolName: 'create_branch',
        arguments: { name: 'fix/x' },
      });

      const pending = store.approvals.listPending('ses_1');
      expect(pending.length).toBe(1);
      expect(pending[0]?.arguments).toEqual({ name: 'fix/x' });

      store.approvals.decide({ requestId: 'req_1', status: 'allowed' });
      expect(store.approvals.listPending('ses_1').length).toBe(0);
    });

    it('records a question and its answer', () => {
      store.requests.create({
        id: 'req_q',
        sessionId: 'ses_1',
        kind: 'clarification',
        question: 'Which environment?',
        options: ['staging', 'production'],
      });

      const pending = store.requests.listPending('ses_1');
      expect(pending[0]?.question).toBe('Which environment?');
      expect(pending[0]?.options).toEqual(['staging', 'production']);

      store.requests.answer({ id: 'req_q', answer: 'staging' });
      expect(store.requests.listPending('ses_1').length).toBe(0);
      expect(store.requests.get('req_q')?.answer).toBe('staging');
    });
  });

  describe('the policies', () => {
    it('stores them and reads them back', () => {
      const policy = store.policies.create({
        toolName: 'create_branch',
        match: { name: { startsWith: 'fix/' } },
        effect: 'allow',
        label: 'Allow fix branches',
      });

      expect(policy.id).toMatch(/^pol_/);
      expect(store.policies.get(policy.id)?.match).toEqual({
        name: { startsWith: 'fix/' },
      });
      expect(store.policies.listAll().length).toBe(1);
    });

    it('edits and deletes them', () => {
      const policy = store.policies.create({
        toolName: 'create_branch',
        effect: 'ask',
      });

      expect(store.policies.update(policy.id, { effect: 'deny' })?.effect).toBe('deny');
      expect(store.policies.update(policy.id, { enabled: false })?.enabled).toBe(false);
      expect(store.policies.delete(policy.id)).toBe(true);
      expect(store.policies.delete(policy.id)).toBe(false);
    });

    it('lists the global policies and the session ones together', () => {
      store.policies.create({ toolName: 'echo', effect: 'allow' });
      store.policies.create({
        toolName: 'echo',
        effect: 'deny',
        sessionId: 'ses_1',
      });

      const forSession = store.policies.listForSession('ses_1');
      expect(forSession.length).toBe(2);
      expect(store.policies.listForSession('ses_2').length).toBe(1);
    });
  });
});
