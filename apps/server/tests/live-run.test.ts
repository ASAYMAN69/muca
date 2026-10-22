import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LiveService } from '../src/live/service.js';
import { MucaStore } from '../src/store/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createTools } from '../src/tools/index.js';
import { createAskUserTool } from '../src/tools/ask-user.js';
import type {
  AIProvider,
  ProviderResponse,
  ProviderStreamEvent,
} from '../src/ai/provider.js';

/**
 * A provider that asks for a fixed script of tool calls.
 *
 * It streams, so the run has deltas to send, and it answers with a
 * tool call on the first turn of each run.
 */
class ScriptedProvider implements AIProvider {
  readonly name = 'scripted-provider';

  private turn = 0;
  private run = 0;

  constructor(
    private readonly script: Array<{
      tool: string;
      arguments: Record<string, unknown>;
    }>,
  ) {}

  async chat(input: { messages: unknown[] }): Promise<ProviderResponse> {
    if (input.messages.length <= 2) {
      this.turn = 0;
      this.run += 1;
    }
    this.turn += 1;

    const step = this.script[Math.min(this.run - 1, this.script.length - 1)]!;
    if (this.turn === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: `call_${this.run}`,
            name: step.tool,
            arguments: JSON.stringify(step.arguments),
          },
        ],
        finishReason: 'tool_calls',
      };
    }

    return { content: 'All done.', toolCalls: [], finishReason: 'stop' };
  }

  async chatStream(
    input: { messages: unknown[] },
    onEvent: (event: ProviderStreamEvent) => void,
  ): Promise<ProviderResponse> {
    if (input.messages.length <= 2) {
      this.turn = 0;
      this.run += 1;
    }
    this.turn += 1;

    const step = this.script[Math.min(this.run - 1, this.script.length - 1)]!;

    if (this.turn === 1) {
      onEvent({ type: 'thinking_delta', text: 'Let me look at that.' });
      onEvent({ type: 'message_delta', text: 'Working on it.' });
      return {
        content: 'Working on it.',
        toolCalls: [
          {
            id: `call_${this.run}`,
            name: step.tool,
            arguments: JSON.stringify(step.arguments),
          },
        ],
        finishReason: 'tool_calls',
      };
    }

    onEvent({ type: 'message_delta', text: 'All done.' });
    return { content: 'All done.', toolCalls: [], finishReason: 'stop' };
  }
}

describe('a live run', () => {
  let dir: string;
  let store: MucaStore;
  let service: LiveService;

  const framesOf = (sessionId: string): Array<Record<string, unknown>> =>
    service.hub.session(sessionId).framesSince(0) as unknown as Array<
      Record<string, unknown>
    >;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muca-run-'));
    store = new MucaStore(join(dir, 'muca.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function buildService(provider: AIProvider): LiveService {
    const registry = new ToolRegistry().registerAll(createTools());
    const liveRegistry = new ToolRegistry().registerAll([
      ...registry.list(),
      createAskUserTool(),
    ]);

    return new LiveService({
      store,
      provider,
      registry,
      liveRegistry,
      systemPrompt: 'You are Muca.',
    });
  }

  it('streams the run in order, with no gaps', async () => {
    service = buildService(
      new ScriptedProvider([{ tool: 'echo', arguments: { message: 'hi' } }]),
    );

    const run = service.start({
      sessionId: 'ses_1',
      message: 'say hi',
      history: [],
    })!;

    await run.whenSettled();

    const frames = framesOf('ses_1');
    const types = frames.map((frame) => frame.type);

    expect(types[0]).toBe('run_started');
    expect(types).toContain('thinking_delta');
    expect(types).toContain('message_delta');
    expect(types).toContain('tool_call_started');
    expect(types).toContain('tool_call_completed');
    expect(types[types.length - 1]).toBe('run_finished');

    // The sequence numbers are strictly increasing: no frame is lost.
    const seqs = frames.map((frame) => frame.seq as number);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it('reports the provider and the model in the first frame', async () => {
    service = buildService(
      new ScriptedProvider([{ tool: 'echo', arguments: { message: 'hi' } }]),
    );

    const run = service.start({
      sessionId: 'ses_1',
      message: 'say hi',
      history: [],
    })!;
    await run.whenSettled();

    const first = framesOf('ses_1')[0]!;
    const data = first.data as { message: string; provider: string };
    expect(data.message).toBe('say hi');
    expect(data.provider).toBe('scripted-provider');
  });

  it('asks about a tool that writes, using the tool definition', async () => {
    service = buildService(
      new ScriptedProvider([
        { tool: 'create_branch', arguments: { name: 'fix/x', baseBranch: 'main' } },
      ]),
    );

    const run = service.start({
      sessionId: 'ses_1',
      message: 'create a branch',
      history: [],
    })!;

    await run.whenParked();

    const request = framesOf('ses_1').find(
      (frame) => frame.type === 'permission_requested',
    )!;

    const data = request.data as {
      requestId: string;
      tool: string;
      title: string;
      description: string;
      arguments: Record<string, unknown>;
      reason: string;
      matchedPolicy: string | null;
    };

    expect(data.tool).toBe('create_branch');
    // The title and the description come from the tool, not the model.
    expect(data.title).toBe('Create branch');
    expect(data.description).toContain('git branch');
    expect(data.arguments).toEqual({ name: 'fix/x', baseBranch: 'main' });
    expect(data.reason).toBe('no policy matched, and this tool writes');
    expect(data.matchedPolicy).toBeNull();
    expect(data.requestId).toMatch(/^req_/);

    // The tool has not run.
    expect(
      framesOf('ses_1').some((frame) => frame.type === 'tool_call_completed'),
    ).toBe(false);

    service.decide({
      sessionId: 'ses_1',
      requestId: data.requestId,
      decision: 'allow',
      remember: false,
    });

    await run.whenSettled();

    const completed = framesOf('ses_1').find(
      (frame) => frame.type === 'tool_call_completed',
    )!;
    expect((completed.data as { summary: string }).summary).toContain(
      'Created branch',
    );
  });

  it('does not run a write tool when the user says no', async () => {
    service = buildService(
      new ScriptedProvider([
        { tool: 'create_branch', arguments: { name: 'fix/x', baseBranch: 'main' } },
      ]),
    );

    const run = service.start({
      sessionId: 'ses_1',
      message: 'create a branch',
      history: [],
    })!;

    await run.whenParked();

    const request = framesOf('ses_1').find(
      (frame) => frame.type === 'permission_requested',
    )!;
    const requestId = (request.data as { requestId: string }).requestId;

    service.decide({
      sessionId: 'ses_1',
      requestId,
      decision: 'deny',
      remember: false,
    });

    await run.whenSettled();

    expect(
      framesOf('ses_1').some((frame) => frame.type === 'tool_call_completed'),
    ).toBe(false);

    const resolved = framesOf('ses_1').find(
      (frame) => frame.type === 'permission_resolved',
    )!;
    expect((resolved.data as { decision: string }).decision).toBe('deny');
  });

  it('runs a write tool straight away when a policy allows it', async () => {
    store.policies.create({
      toolName: 'create_branch',
      match: { name: { startsWith: 'fix/' } },
      effect: 'allow',
      label: 'fix branches',
    });

    service = buildService(
      new ScriptedProvider([
        { tool: 'create_branch', arguments: { name: 'fix/x', baseBranch: 'main' } },
      ]),
    );

    const run = service.start({
      sessionId: 'ses_1',
      message: 'create a branch',
      history: [],
    })!;
    await run.whenSettled();

    // Nobody was asked.
    expect(
      framesOf('ses_1').some((frame) => frame.type === 'permission_requested'),
    ).toBe(false);

    const completed = framesOf('ses_1').find(
      (frame) => frame.type === 'tool_call_completed',
    )!;
    expect(completed).toBeDefined();
  });

  it('refuses a write tool when a policy denies it, and says why', async () => {
    store.policies.create({
      toolName: 'create_branch',
      effect: 'deny',
      label: 'no branches today',
    });

    service = buildService(
      new ScriptedProvider([
        { tool: 'create_branch', arguments: { name: 'fix/x', baseBranch: 'main' } },
      ]),
    );

    const run = service.start({
      sessionId: 'ses_1',
      message: 'create a branch',
      history: [],
    })!;
    await run.whenSettled();

    expect(
      framesOf('ses_1').some((frame) => frame.type === 'tool_call_completed'),
    ).toBe(false);

    const request = framesOf('ses_1').find(
      (frame) => frame.type === 'permission_requested',
    )!;
    expect((request.data as { reason: string }).reason).toContain(
      'no branches today',
    );
    expect((request.data as { matchedPolicy: string | null }).matchedPolicy).toBe(
      'no branches today',
    );
  });

  it('asks the user a question and continues when the answer arrives', async () => {
    service = buildService(
      new ScriptedProvider([
        {
          tool: 'ask_user',
          arguments: { question: 'Which environment?', options: ['staging', 'prod'] },
        },
      ]),
    );

    const run = service.start({
      sessionId: 'ses_1',
      message: 'deploy it',
      history: [],
    })!;

    await run.whenParked();

    const request = framesOf('ses_1').find(
      (frame) => frame.type === 'clarification_requested',
    )!;
    const data = request.data as {
      requestId: string;
      question: string;
      options?: string[];
    };
    expect(data.question).toBe('Which environment?');
    expect(data.options).toEqual(['staging', 'prod']);

    service.answer({
      sessionId: 'ses_1',
      requestId: data.requestId,
      text: 'staging',
    });

    await run.whenSettled();

    const answered = framesOf('ses_1').find(
      (frame) => frame.type === 'clarification_answered',
    )!;
    expect((answered.data as { answer: string }).answer).toBe('staging');
  });

  it('flushes the run to the database when it ends', async () => {
    service = buildService(
      new ScriptedProvider([{ tool: 'echo', arguments: { message: 'hi' } }]),
    );

    const run = service.start({
      sessionId: 'ses_1',
      message: 'say hi',
      history: [],
    })!;
    await run.whenSettled();

    // The messages.
    const messages = store.messages.list('ses_1');
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    // The events.
    const events = store.events.readFrom('ses_1', 0);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.type).toBe('run_started');

    // The run row.
    const stored = store.runs.get(run.runId);
    expect(stored?.outcome).toBe('completed');
    expect(stored?.toolCallCount).toBe(1);
  });

  it('remembers a decision as a policy when the user asks it to', async () => {
    service = buildService(
      new ScriptedProvider([
        { tool: 'create_branch', arguments: { name: 'fix/x', baseBranch: 'main' } },
      ]),
    );

    const run = service.start({
      sessionId: 'ses_1',
      message: 'create a branch',
      history: [],
    })!;

    await run.whenParked();

    const request = framesOf('ses_1').find(
      (frame) => frame.type === 'permission_requested',
    )!;
    const requestId = (request.data as { requestId: string }).requestId;

    service.decide({
      sessionId: 'ses_1',
      requestId,
      decision: 'allow',
      remember: true,
    });

    await run.whenSettled();

    const policies = store.policies.listAll();
    expect(policies.length).toBe(1);
    expect(policies[0]?.toolName).toBe('create_branch');
    expect(policies[0]?.effect).toBe('allow');
    expect(policies[0]?.sessionId).toBeNull();
    expect(policies[0]?.match).toEqual({
      name: { equals: 'fix/x' },
      baseBranch: { equals: 'main' },
    });
  });

  it('does not let a call with different arguments run under an approval', async () => {
    // The model asks for one branch, and then — after the tool ran —
    // asks for a different one. The second one is a different action,
    // so it needs a fresh decision.
    let turn = 0;
    const provider: AIProvider = {
      name: 'switching-provider',
      async chat() {
        turn += 1;
        if (turn === 1) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'call_1',
                name: 'create_branch',
                arguments: JSON.stringify({ name: 'approved/x', baseBranch: 'main' }),
              },
            ],
            finishReason: 'tool_calls',
          };
        }
        if (turn === 2) {
          return {
            content: null,
            toolCalls: [
              {
                id: 'call_2',
                name: 'create_branch',
                arguments: JSON.stringify({ name: 'other/x', baseBranch: 'main' }),
              },
            ],
            finishReason: 'tool_calls',
          };
        }
        return { content: 'All done.', toolCalls: [], finishReason: 'stop' };
      },
    };

    service = buildService(provider);

    const run = service.start({
      sessionId: 'ses_1',
      message: 'create a branch',
      history: [],
    })!;
    await run.whenParked();

    const requests = () =>
      framesOf('ses_1').filter((frame) => frame.type === 'permission_requested');

    const first = requests()[0]!;
    const firstId = (first.data as { requestId: string }).requestId;

    service.decide({
      sessionId: 'ses_1',
      requestId: firstId,
      decision: 'allow',
      remember: false,
    });

    // The run parks again on the *other* branch.
    for (let attempt = 0; attempt < 200 && requests().length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const second = requests()[1]!;
    const secondData = second.data as {
      requestId: string;
      arguments: Record<string, unknown>;
    };
    expect(secondData.arguments.name).toBe('other/x');
    expect(secondData.requestId).not.toBe(firstId);

    // Only the approved branch was created.
    const completed = framesOf('ses_1').filter(
      (frame) => frame.type === 'tool_call_completed',
    );
    expect(completed.length).toBe(1);
    expect((completed[0]?.data as { summary: string }).summary).toContain(
      'approved/x',
    );

    // And the other branch never runs without its own decision.
    service.decide({
      sessionId: 'ses_1',
      requestId: secondData.requestId,
      decision: 'deny',
      remember: false,
    });
    await run.whenSettled();

    expect(
      framesOf('ses_1').filter((frame) => frame.type === 'tool_call_completed')
        .length,
    ).toBe(1);
  });
});
