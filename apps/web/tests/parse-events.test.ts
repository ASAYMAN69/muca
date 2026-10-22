import { describe, expect, it } from 'vitest';

import { parseAgentEvents, type AgentEvent } from '../lib/api';

/**
 * The event parser.
 *
 * The server's event union uses two names for the same thing: `id` on
 * `tool_call` and `tool_result`, `callId` on `confirmation_required` and
 * `approval_decision`. The parser has to read both, or the timeline cannot
 * match a call to its approval and shows two rows for one tool call.
 */

function parseOne(raw: unknown): AgentEvent {
  const { events, unknown } = parseAgentEvents([raw]);
  expect(unknown).toEqual([]);
  expect(events).toHaveLength(1);
  return events[0];
}

describe('parseAgentEvents', () => {
  it('reads the id of a tool call', () => {
    const event = parseOne({
      type: 'tool_call',
      id: 'call_1',
      name: 'create_branch',
      arguments: { name: 'fix/x', baseBranch: 'main' },
    });

    expect(event).toEqual({
      type: 'tool_call',
      id: 'call_1',
      name: 'create_branch',
      arguments: { name: 'fix/x', baseBranch: 'main' },
    });
  });

  it('reads the id of a tool result', () => {
    const event = parseOne({
      type: 'tool_result',
      id: 'call_1',
      name: 'create_branch',
      summary: 'Created branch "fix/x".',
      data: { name: 'fix/x' },
    });

    expect(event).toEqual({
      type: 'tool_result',
      id: 'call_1',
      name: 'create_branch',
      summary: 'Created branch "fix/x".',
      data: { name: 'fix/x' },
    });
  });

  it('reads the callId of a confirmation request', () => {
    const event = parseOne({
      type: 'confirmation_required',
      callId: 'call_1',
      name: 'create_branch',
      arguments: { name: 'fix/x' },
      message: 'Create branch (name="fix/x")',
    });

    expect(event).toEqual({
      type: 'confirmation_required',
      id: 'call_1',
      name: 'create_branch',
      arguments: { name: 'fix/x' },
      message: 'Create branch (name="fix/x")',
      title: undefined,
      description: undefined,
      reason: undefined,
      matchedPolicy: null,
    });
  });

  it('reads the id of a confirmation request when the server sends that', () => {
    const event = parseOne({
      type: 'confirmation_required',
      id: 'call_1',
      name: 'create_branch',
      arguments: { name: 'fix/x' },
      message: 'Create branch (name="fix/x")',
    });

    expect(event.type).toBe('confirmation_required');
    expect(event.type === 'confirmation_required' && event.id).toBe('call_1');
  });

  it('reads the callId of an approval decision', () => {
    const event = parseOne({
      type: 'approval_decision',
      callId: 'call_1',
      name: 'create_branch',
      approved: false,
      source: 'http',
    });

    expect(event).toEqual({
      type: 'approval_decision',
      id: 'call_1',
      name: 'create_branch',
      approved: false,
      source: 'http',
    });
  });

  it('reads the id of an approval decision when the server sends that', () => {
    const event = parseOne({
      type: 'approval_decision',
      id: 'call_1',
      name: 'create_branch',
      approved: true,
    });

    expect(event.type).toBe('approval_decision');
    expect(event.type === 'approval_decision' && event.id).toBe('call_1');
    expect(event.type === 'approval_decision' && event.approved).toBe(true);
  });

  it('prefers callId when an event carries both names', () => {
    const event = parseOne({
      type: 'approval_decision',
      id: 'stale_id',
      callId: 'call_1',
      name: 'create_branch',
      approved: true,
    });

    expect(event.type === 'approval_decision' && event.id).toBe('call_1');
  });

  it('parses text and error events', () => {
    expect(parseOne({ type: 'text', text: 'On it.' })).toEqual({
      type: 'text',
      text: 'On it.',
    });
    expect(parseOne({ type: 'error', message: 'It broke.' })).toEqual({
      type: 'error',
      message: 'It broke.',
    });
  });

  it('carries an unknown event type separately', () => {
    const raw = { type: 'elicitation_request', id: 'x', message: 'Which one?' };
    const { events, unknown } = parseAgentEvents([
      { type: 'text', text: 'On it.' },
      raw,
    ]);

    expect(events).toHaveLength(1);
    expect(unknown).toEqual([raw]);
  });

  it('carries malformed events separately instead of throwing', () => {
    const { events, unknown } = parseAgentEvents([
      null,
      'not an object',
      { noType: true },
      { type: 42 },
    ]);

    expect(events).toEqual([]);
    expect(unknown).toHaveLength(4);
  });

  it('returns nothing for a payload that is not an array', () => {
    expect(parseAgentEvents({ events: [] })).toEqual({ events: [], unknown: [] });
    expect(parseAgentEvents(undefined)).toEqual({ events: [], unknown: [] });
  });
});
