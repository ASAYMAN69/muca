import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunHistoryStore, type RunRecord } from '../src/store/run-history.js';
import {
  PendingApprovalRegistry,
  MAX_PENDING_APPROVALS,
} from '../src/store/pending-approvals.js';

/** A temp directory that is removed after the test. */
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'muca-runs-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function sampleRun(id: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    startedAt: '2026-03-14T09:00:00.000Z',
    finishedAt: '2026-03-14T09:00:05.000Z',
    userMessage: 'why did the deploy fail?',
    text: 'The readiness probe was too shallow.',
    outcome: 'completed',
    toolCalls: [
      {
        id: 'call_1',
        name: 'list_deployments',
        arguments: { service: 'checkout-api' },
        summary: 'Found 3 deployment(s)',
        at: '2026-03-14T09:00:01.000Z',
      },
    ],
    approvals: [
      {
        requestId: 'call_2',
        toolName: 'create_branch',
        decision: 'approved',
        source: 'elicitation',
        at: '2026-03-14T09:00:02.000Z',
      },
    ],
    taskId: null,
    error: null,
    ...overrides,
  };
}

describe('RunHistoryStore', () => {
  it('writes a run and reads it back', async () => {
    const store = new RunHistoryStore(tempDir());
    const run = sampleRun('run_1');

    await store.save(run);

    const loaded = store.get('run_1');
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe('run_1');
    expect(loaded?.userMessage).toBe('why did the deploy fail?');
    expect(loaded?.toolCalls).toHaveLength(1);
    expect(loaded?.approvals).toHaveLength(1);
    expect(loaded?.approvals[0]?.decision).toBe('approved');
    expect(loaded?.approvals[0]?.source).toBe('elicitation');
    expect(loaded?.outcome).toBe('completed');
  });

  it('survives a server restart: a new store sees the old data', async () => {
    const dir = tempDir();

    const first = new RunHistoryStore(dir);
    await first.save(sampleRun('run_1'));
    await first.save(sampleRun('run_2', { userMessage: 'second run' }));

    // "Restart": a brand new store instance over the same directory.
    const second = new RunHistoryStore(dir);
    expect(second.get('run_1')).not.toBeNull();
    expect(second.get('run_2')?.userMessage).toBe('second run');
    expect(second.list()).toHaveLength(2);
  });

  it('lists the runs newest first', async () => {
    const store = new RunHistoryStore(tempDir());

    await store.save(sampleRun('run_1'));
    await store.save(sampleRun('run_2'));
    await store.save(sampleRun('run_3'));

    const runs = store.list();
    expect(runs).toHaveLength(3);
    // The most recently written run comes first.
    expect(runs[0]?.id).toBe('run_3');
  });

  it('returns a summary with the tool and approval counts', async () => {
    const store = new RunHistoryStore(tempDir());
    await store.save(sampleRun('run_1'));

    const [summary] = store.list();
    expect(summary?.toolCallCount).toBe(1);
    expect(summary?.approvalCount).toBe(1);
    expect(summary?.taskId).toBeNull();
  });

  it('caps the number of runs it returns', async () => {
    const store = new RunHistoryStore(tempDir());
    for (let i = 0; i < 5; i += 1) {
      await store.save(sampleRun(`run_${i}`));
    }

    expect(store.list(2)).toHaveLength(2);
  });

  it('returns null for an unknown run', () => {
    const store = new RunHistoryStore(tempDir());
    expect(store.get('run_nope')).toBeNull();
  });

  it('refuses a run id that would escape the directory', () => {
    const store = new RunHistoryStore(tempDir());
    expect(store.get('../../etc/passwd')).toBeNull();
  });

  it('survives a corrupt file without failing the listing', async () => {
    const dir = tempDir();
    const store = new RunHistoryStore(dir);
    await store.save(sampleRun('run_1'));

    // Write garbage over one of the files.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'run_broken.json'), 'not json at all', 'utf8');

    const runs = store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe('run_1');
  });

  it('clears every stored run', async () => {
    const store = new RunHistoryStore(tempDir());
    await store.save(sampleRun('run_1'));
    await store.save(sampleRun('run_2'));

    expect(store.clear()).toBe(2);
    expect(store.list()).toHaveLength(0);
  });

  it('serialises concurrent writes', async () => {
    const store = new RunHistoryStore(tempDir());

    await Promise.all([
      store.save(sampleRun('run_1')),
      store.save(sampleRun('run_2')),
      store.save(sampleRun('run_3')),
    ]);

    expect(store.list()).toHaveLength(3);
    for (const id of ['run_1', 'run_2', 'run_3']) {
      expect(store.get(id)).not.toBeNull();
    }
  });
});

describe('PendingApprovalRegistry', () => {
  it('remembers a parked approval by call id', () => {
    const registry = new PendingApprovalRegistry();

    registry.add({
      callId: 'call_1',
      toolName: 'create_branch',
      arguments: { name: 'fix/x' },
      at: '2026-03-14T09:00:00.000Z',
    });

    expect(registry.get('call_1')?.toolName).toBe('create_branch');
    expect(registry.latestForTool('create_branch')?.callId).toBe('call_1');
  });

  it('forgets a removed approval', () => {
    const registry = new PendingApprovalRegistry();

    registry.add({
      callId: 'call_1',
      toolName: 'create_branch',
      arguments: {},
      at: '2026-03-14T09:00:00.000Z',
    });
    registry.remove('call_1');

    expect(registry.get('call_1')).toBeUndefined();
    expect(registry.latestForTool('create_branch')).toBeUndefined();
  });

  it('is bounded', () => {
    const registry = new PendingApprovalRegistry();

    for (let i = 0; i < MAX_PENDING_APPROVALS + 10; i += 1) {
      registry.add({
        callId: `call_${i}`,
        toolName: `tool_${i}`,
        arguments: {},
        at: '2026-03-14T09:00:00.000Z',
      });
    }

    expect(registry.size).toBeLessThanOrEqual(MAX_PENDING_APPROVALS);
  });

  it('clears everything', () => {
    const registry = new PendingApprovalRegistry();
    registry.add({
      callId: 'call_1',
      toolName: 'create_branch',
      arguments: {},
      at: '2026-03-14T09:00:00.000Z',
    });

    registry.clear();
    expect(registry.size).toBe(0);
  });
});
