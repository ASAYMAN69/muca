import { describe, expect, it } from 'vitest';

import type { LiveFrame } from '../lib/live';
import { applyFrame, emptyRun, type LiveRunState } from '../lib/live-run';

/**
 * The live run reducer.
 *
 * Every frame of the protocol (§3) has to end up in the same shape the
 * request/response path produces, so one timeline renders both.
 */

function frame(type: string, data: unknown, seq = 1): LiveFrame {
  return {
    seq,
    sessionId: 'ses_1',
    runId: 'run_1',
    ts: '2026-10-22T09:14:22.401Z',
    type,
    data,
  };
}

function run(...frames: LiveFrame[]): LiveRunState {
  return frames.reduce(applyFrame, emptyRun('run_1'));
}

describe('applyFrame', () => {
  it('starts a run', () => {
    const state = run(frame('run_started', { message: 'triage it', provider: 'openai', model: 'gpt-5' }));

    expect(state.status).toBe('running');
    expect(state.provider).toBe('openai');
    expect(state.model).toBe('gpt-5');
  });

  it('accumulates the thinking', () => {
    const state = run(
      frame('thinking_delta', { text: 'Looking at ' }),
      frame('thinking_delta', { text: 'the deploys.' }),
    );

    expect(state.thinking).toBe('Looking at the deploys.');
    expect(state.thinkingActive).toBe(true);
  });

  it('types the answer in', () => {
    const state = run(
      frame('message_delta', { text: 'The deploy ' }),
      frame('message_delta', { text: 'failed.' }),
    );

    expect(state.text).toBe('The deploy failed.');
  });

  it('shows a tool call before the tool finishes', () => {
    const state = run(
      frame('tool_call_started', {
        callId: 'call_1',
        name: 'list_deployments',
        arguments: { service: 'checkout-api' },
      }),
    );

    expect(state.events).toEqual([
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'list_deployments',
        arguments: { service: 'checkout-api' },
      },
    ]);
    expect(state.status).toBe('running');
  });

  it('resolves a tool call when the result arrives', () => {
    const state = run(
      frame('tool_call_started', { callId: 'call_1', name: 'echo', arguments: {} }),
      frame('tool_call_completed', {
        callId: 'call_1',
        name: 'echo',
        summary: 'echoed',
        data: { ok: true },
        ok: true,
      }),
    );

    expect(state.events[1]).toMatchObject({
      type: 'tool_result',
      id: 'call_1',
      summary: 'echoed',
    });
  });

  it('records a failed tool call as an error too', () => {
    const state = run(
      frame('tool_call_started', { callId: 'call_1', name: 'echo', arguments: {} }),
      frame('tool_call_completed', {
        callId: 'call_1',
        name: 'echo',
        summary: 'it broke',
        ok: false,
      }),
    );

    expect(state.events[2]).toEqual({ type: 'error', message: 'it broke' });
  });

  it('parks the run on a permission request', () => {
    const state = run(
      frame('tool_call_started', {
        callId: 'call_1',
        name: 'create_branch',
        arguments: { name: 'fix/x' },
      }),
      frame('permission_requested', {
        requestId: 'req_1',
        tool: 'create_branch',
        title: 'Create a branch',
        description: 'Creates a branch on the remote.',
        arguments: { name: 'fix/x' },
        reason: 'no policy matched, and this tool writes',
        matchedPolicy: null,
      }),
    );

    expect(state.status).toBe('waiting');
    expect(state.awaitingConfirmation).toBe(true);
    // The request names the request; the call it is about is the tool
    // call that is still running.
    expect(state.pending).toMatchObject({
      callId: 'call_1',
      requestId: 'req_1',
      name: 'create_branch',
      title: 'Create a branch',
      reason: 'no policy matched, and this tool writes',
    });
    expect(state.events[1]).toMatchObject({
      type: 'confirmation_required',
      id: 'call_1',
      reason: 'no policy matched, and this tool writes',
    });
  });

  it('resolves the permission when the user decides', () => {
    const state = run(
      frame('tool_call_started', {
        callId: 'call_1',
        name: 'create_branch',
        arguments: { name: 'fix/x' },
      }),
      frame('permission_requested', {
        requestId: 'req_1',
        tool: 'create_branch',
        arguments: { name: 'fix/x' },
      }),
      frame('permission_resolved', { requestId: 'req_1', decision: 'allow' }),
    );

    expect(state.pending).toBeNull();
    expect(state.awaitingConfirmation).toBe(false);
    expect(state.events[2]).toMatchObject({
      type: 'approval_decision',
      id: 'call_1',
      approved: true,
    });
  });

  it('records a denial as a denial', () => {
    const state = run(
      frame('tool_call_started', {
        callId: 'call_1',
        name: 'create_branch',
        arguments: { name: 'fix/x' },
      }),
      frame('permission_requested', {
        requestId: 'req_1',
        tool: 'create_branch',
        arguments: { name: 'fix/x' },
      }),
      frame('permission_resolved', { requestId: 'req_1', decision: 'deny' }),
    );

    expect(state.events[2]).toMatchObject({ approved: false });
  });

  it('parks the run on a question', () => {
    const state = run(
      frame('clarification_requested', {
        requestId: 'req_2',
        question: 'Which environment?',
        options: ['prod', 'staging'],
      }),
    );

    expect(state.status).toBe('waiting');
    expect(state.clarification).toMatchObject({
      id: 'req_2',
      question: 'Which environment?',
      options: ['prod', 'staging'],
    });
    expect(state.events[0]).toMatchObject({ type: 'clarification', id: 'req_2' });
  });

  it('records the answer to a question', () => {
    const state = run(
      frame('clarification_requested', { requestId: 'req_2', question: 'Which one?' }),
      frame('clarification_answered', { requestId: 'req_2', answer: 'prod' }),
    );

    expect(state.clarification?.answer).toBe('prod');
    expect(state.events[1]).toMatchObject({
      type: 'clarification_answered',
      answer: 'prod',
    });
  });

  it('finishes a run with its counts', () => {
    const state = run(
      frame('run_finished', {
        outcome: 'completed',
        toolCallCount: 3,
        approvalCount: 1,
        durationMs: 4210,
      }),
    );

    expect(state.status).toBe('done');
    expect(state.outcome).toBe('completed');
    expect(state.toolCallCount).toBe(3);
    expect(state.approvalCount).toBe(1);
    expect(state.durationMs).toBe(4210);
  });

  it('records a run error', () => {
    const state = run(frame('run_error', { message: 'The provider gave up.' }));

    expect(state.status).toBe('error');
    expect(state.error).toBe('The provider gave up.');
    expect(state.events[0]).toEqual({
      type: 'error',
      message: 'The provider gave up.',
    });
  });

  it('ignores a frame it does not know', () => {
    const state = run(frame('pong', {}));
    expect(state.events).toEqual([]);
  });
});
