import { describe, expect, it } from 'vitest';

import { parseAgentEvents, type PendingCall } from '../lib/api';
import {
  buildTimeline,
  formatArgument,
  formatArguments,
  type TimelineStep,
} from '../lib/timeline';

/**
 * The timeline model.
 *
 * The rule these tests protect: **one tool call is one row.** A call that
 * needs approval is upgraded into its approval row, and the decision that
 * follows resolves that same row.
 *
 * The events below are the shapes the server actually sends: `tool_call`
 * and `tool_result` carry `id`, while `confirmation_required` and
 * `approval_decision` carry `callId`.
 */

const BRANCH_ARGS = { name: 'fix/checkout-missing-customer', baseBranch: 'main' };

const PENDING: PendingCall = {
  callId: 'call_1',
  name: 'create_branch',
  arguments: BRANCH_ARGS,
  message: 'Create branch (name="fix/checkout-missing-customer")',
};

const DESTRUCTIVE = new Set(['create_branch', 'open_pull_request']);

/** The events the server sends when a run parks on a destructive call. */
function parkedEvents() {
  return [
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'create_branch',
      arguments: BRANCH_ARGS,
    },
    {
      type: 'approval_decision',
      callId: 'call_1',
      name: 'create_branch',
      approved: false,
      source: 'http',
    },
    {
      type: 'confirmation_required',
      callId: 'call_1',
      name: 'create_branch',
      arguments: BRANCH_ARGS,
      message: PENDING.message,
    },
  ];
}

/** The events the server sends after the user approved the call. */
function approvedEvents() {
  return [
    {
      type: 'tool_call',
      id: 'call_1',
      name: 'create_branch',
      arguments: BRANCH_ARGS,
    },
    {
      type: 'approval_decision',
      callId: 'call_1',
      name: 'create_branch',
      approved: true,
      source: 'http',
    },
    {
      type: 'tool_result',
      id: 'call_1',
      name: 'create_branch',
      summary: 'Created branch "fix/checkout-missing-customer" from "main".',
      data: { name: 'fix/checkout-missing-customer' },
    },
  ];
}

/** The rows that belong to one tool call. */
function rowsFor(timeline: { steps: TimelineStep[] }, callId: string) {
  return timeline.steps.filter((step) => step.callId === callId);
}

describe('buildTimeline — a parked run', () => {
  it('shows one row for the tool call, waiting for the user', () => {
    const { events } = parseAgentEvents(parkedEvents());
    const timeline = buildTimeline({
      events,
      pendingCall: PENDING,
      awaitingConfirmation: true,
      destructiveTools: DESTRUCTIVE,
    });

    expect(timeline.steps).toHaveLength(1);

    const [step] = timeline.steps;
    expect(step.kind).toBe('approval');
    expect(step.status).toBe('blocked');
    expect(step.title).toBe('Create Branch');
    expect(step.toolName).toBe('create_branch');
    expect(step.callId).toBe('call_1');
    expect(step.destructive).toBe(true);
  });

  it('never shows a declined row next to the waiting row', () => {
    const { events } = parseAgentEvents(parkedEvents());
    const timeline = buildTimeline({
      events,
      pendingCall: PENDING,
      awaitingConfirmation: true,
      destructiveTools: DESTRUCTIVE,
    });

    expect(
      timeline.steps.filter((step) => step.status === 'rejected'),
    ).toHaveLength(0);
  });

  it('shows the exact arguments the server will run', () => {
    const { events } = parseAgentEvents(parkedEvents());
    const timeline = buildTimeline({
      events,
      pendingCall: PENDING,
      awaitingConfirmation: true,
      destructiveTools: DESTRUCTIVE,
    });

    expect(timeline.steps[0].arguments).toEqual([
      { key: 'name', value: 'fix/checkout-missing-customer' },
      { key: 'baseBranch', value: 'main' },
    ]);
    expect(timeline.steps[0].summary).toBe(PENDING.message);
  });
});

describe('buildTimeline — a cancelled run', () => {
  it('resolves the one row to declined', () => {
    const { events } = parseAgentEvents(parkedEvents());
    const timeline = buildTimeline({
      events,
      pendingCall: null,
      awaitingConfirmation: false,
      destructiveTools: DESTRUCTIVE,
    });

    expect(timeline.steps).toHaveLength(1);
    expect(timeline.steps[0].status).toBe('rejected');
    expect(timeline.steps[0].summary).toMatch(/declined/i);
  });

  it('leaves no stale row behind for the next attempt', () => {
    const { events } = parseAgentEvents(parkedEvents());
    const cancelled = buildTimeline({
      events,
      pendingCall: null,
      awaitingConfirmation: false,
      destructiveTools: DESTRUCTIVE,
    });

    // The next attempt is a new run, and it parks on a new call.
    const next = buildTimeline({
      events: parseAgentEvents([
        {
          type: 'tool_call',
          id: 'call_2',
          name: 'open_pull_request',
          arguments: { title: 'fix: load the customer first' },
        },
        {
          type: 'confirmation_required',
          callId: 'call_2',
          name: 'open_pull_request',
          arguments: { title: 'fix: load the customer first' },
          message: 'Open pull request',
        },
      ]).events,
      pendingCall: {
        callId: 'call_2',
        name: 'open_pull_request',
        arguments: { title: 'fix: load the customer first' },
        message: 'Open pull request',
      },
      awaitingConfirmation: true,
      destructiveTools: DESTRUCTIVE,
    });

    expect(cancelled.steps).toHaveLength(1);
    expect(cancelled.steps[0].status).toBe('rejected');

    expect(next.steps).toHaveLength(1);
    expect(next.steps[0].status).toBe('blocked');
    expect(next.steps.filter((step) => step.status === 'rejected')).toHaveLength(
      0,
    );
  });
});

describe('buildTimeline — an approved run', () => {
  it('resolves the same row to ok when the result arrives', () => {
    const { events } = parseAgentEvents(approvedEvents());
    const timeline = buildTimeline({
      events,
      pendingCall: null,
      awaitingConfirmation: false,
      destructiveTools: DESTRUCTIVE,
    });

    const rows = rowsFor(timeline, 'call_1');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].summary).toMatch(/approved by you/i);
  });

  it('shows the result as its own evidence row', () => {
    const { events } = parseAgentEvents(approvedEvents());
    const timeline = buildTimeline({
      events,
      pendingCall: null,
      awaitingConfirmation: false,
      destructiveTools: DESTRUCTIVE,
    });

    const evidence = timeline.steps.filter((step) => step.kind === 'evidence');
    expect(evidence).toHaveLength(1);
    expect(evidence[0].resultSummary).toMatch(/Created branch/);
  });

  it('shows one row per call, not one per event', () => {
    const { events } = parseAgentEvents(approvedEvents());
    const timeline = buildTimeline({
      events,
      pendingCall: null,
      awaitingConfirmation: false,
      destructiveTools: DESTRUCTIVE,
    });

    expect(timeline.steps).toHaveLength(2);
    expect(timeline.steps.filter((step) => step.toolName === 'create_branch'))
      .toHaveLength(2);
  });

  it('marks the row failed when the tool errors', () => {
    const { events } = parseAgentEvents([
      ...approvedEvents().slice(0, 2),
      { type: 'error', message: 'The tool blew up.' },
      approvedEvents()[2],
    ]);
    const timeline = buildTimeline({
      events,
      pendingCall: null,
      awaitingConfirmation: false,
      destructiveTools: DESTRUCTIVE,
    });

    const rows = rowsFor(timeline, 'call_1');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].summary).toContain('The tool blew up.');
  });
});

describe('buildTimeline — ordinary calls', () => {
  it('shows one row per non-destructive call', () => {
    const { events } = parseAgentEvents([
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'list_deployments',
        arguments: { service: 'checkout-api' },
      },
      {
        type: 'tool_result',
        id: 'call_1',
        name: 'list_deployments',
        summary: 'Found 3 deployments.',
        data: { count: 3 },
      },
    ]);
    const timeline = buildTimeline({
      events,
      destructiveTools: DESTRUCTIVE,
    });

    expect(timeline.steps).toHaveLength(2);
    expect(timeline.steps[0].kind).toBe('tool_call');
    expect(timeline.steps[0].status).toBe('success');
    expect(timeline.steps[0].destructive).toBe(false);
  });

  it('fails a call that never returned a result', () => {
    const { events } = parseAgentEvents([
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'list_deployments',
        arguments: {},
      },
    ]);
    const timeline = buildTimeline({ events, destructiveTools: DESTRUCTIVE });

    expect(timeline.steps).toHaveLength(1);
    expect(timeline.steps[0].status).toBe('failed');
    expect(timeline.steps[0].summary).toMatch(/did not return a result/i);
  });
});

describe('buildTimeline — unknown events', () => {
  it('keeps an unknown event out of the timeline', () => {
    const { events, unknown } = parseAgentEvents([
      {
        type: 'tool_call',
        id: 'call_1',
        name: 'list_deployments',
        arguments: {},
      },
      { type: 'elicitation_request', id: 'call_1', message: 'Which one?' },
      {
        type: 'tool_result',
        id: 'call_1',
        name: 'list_deployments',
        summary: 'Found 3 deployments.',
        data: { count: 3 },
      },
    ]);

    const timeline = buildTimeline({
      events,
      unknownEvents: unknown,
      destructiveTools: DESTRUCTIVE,
    });

    expect(timeline.steps).toHaveLength(2);
    expect(timeline.unknownEvents).toHaveLength(1);
  });
});

describe('argument formatting', () => {
  it('formats every value type', () => {
    expect(formatArgument('fix/x')).toBe('fix/x');
    expect(formatArgument(42)).toBe('42');
    expect(formatArgument(true)).toBe('true');
    expect(formatArgument(null)).toBe('null');
    expect(formatArgument(undefined)).toBe('—');
    expect(formatArgument({ base: 'main' })).toBe('{"base":"main"}');
    expect(formatArgument(['a', 'b'])).toBe('["a","b"]');
  });

  it('turns an argument object into readable rows', () => {
    expect(
      formatArguments({ name: 'fix/x', baseBranch: 'main', depth: 2 }),
    ).toEqual([
      { key: 'name', value: 'fix/x' },
      { key: 'baseBranch', value: 'main' },
      { key: 'depth', value: '2' },
    ]);
  });

  it('has no rows for missing arguments', () => {
    expect(formatArguments(undefined)).toEqual([]);
    expect(formatArguments({})).toEqual([]);
  });
});
