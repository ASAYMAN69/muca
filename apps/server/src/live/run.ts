import { randomUUID } from 'node:crypto';

import { Agent, type AgentEvent } from '../ai/agent.js';
import {
  compactMessages,
  shouldCompact,
  summarise,
} from '../ai/compaction.js';
import type { ContextLimit } from '../ai/context-limits.js';
import type { AIProvider, ProviderMessage } from '../ai/provider.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { MucaStore } from '../store/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { runInLiveContext } from './context.js';
import type { LiveEventFrame, LiveEventType } from './frames.js';
import { LivePolicyGate } from './policy-gate.js';

/**
 * One live run.
 *
 * The run is the live state of a conversation turn: it streams to the
 * browser as it happens, it can park on a permission or a question, and
 * it is flushed to SQLite when it ends.
 *
 * The two paths of the stream (§6 of the protocol) are here in one
 * place: the frames go to the hub — and from there to the socket — and
 * the same frames are kept in the run's buffer until the run finishes.
 */
export interface LiveRunOptions {
  sessionId: string;
  /** The run id. One is made when it is not given. */
  runId?: string;
  /** What the user asked for. */
  message: string;
  /** The conversation so far. */
  history: ProviderMessage[];
  provider: AIProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  policyEngine: PolicyEngine;
  store: MucaStore;
  /** Publishes a frame to the session. Returns the published frame. */
  publish: (type: LiveEventType, data: unknown) => LiveEventFrame;
  /** The model, for the `run_started` frame. */
  model?: string | null;
  /** The model's input limit, when it is known. */
  contextLimit?: () => Promise<ContextLimit | null>;
  /** The exact number of input tokens, when the provider can count them. */
  countTokens?: (messages: ProviderMessage[]) => Promise<number | null>;
  /** The fraction of the limit at which a conversation is compacted. */
  compactionThreshold?: number;
  /** How many turns are kept verbatim when a conversation is compacted. */
  compactionKeepTurns?: number;
}

/** How a run ended. */
export type LiveRunOutcome = 'completed' | 'error';

/** A decision the user has to make. */
interface PendingDecision {
  resolve: (decision: 'allow' | 'deny') => void;
}

/** An answer the user has to give. */
interface PendingAnswer {
  resolve: (answer: string) => void;
}

export class LiveRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly startedAt: string;

  private readonly options: LiveRunOptions;
  private readonly gate: LivePolicyGate;

  /** The frames of this run, in order. Flushed when the run ends. */
  private readonly frames: Array<{
    seq: number;
    runId: string | null;
    type: LiveEventType;
    data: unknown;
    ts: string;
  }> = [];

  /** The decisions the user still owes. */
  private readonly decisions = new Map<string, PendingDecision>();

  /** The permissions this run asked for, by request id. */
  private readonly permissions = new Map<
    string,
    {
      requestId: string;
      toolName: string;
      title: string;
      arguments: Record<string, unknown>;
      policyId: string | null;
    }
  >();

  /** The answers the user still owes. */
  private readonly answers = new Map<string, PendingAnswer>();

  /** The text the model produced, as it streamed in. */
  private accumulatedText_ = '';

  /** The summary of the conversation, once it has been compacted. */
  private previousSummary: string | null = null;

  /** Every agent event, in order. */
  private readonly agentEventLog: AgentEvent[] = [];

  /** How many tool calls the run made. */
  private toolCallCount = 0;

  /** How many permissions the run asked for. */
  private approvalCount = 0;

  /** The permission the run is parked on, if any. */
  private lastPermission: Record<string, unknown> | null = null;

  /** True once the run has parked on something. */
  private parked = false;

  private parkResolve: (() => void) | null = null;
  private readonly parkedPromise: Promise<void>;

  private settleResolve: ((outcome: LiveRunOutcome) => void) | null = null;
  private readonly settledPromise: Promise<LiveRunOutcome>;

  constructor(options: LiveRunOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.runId = options.runId ?? `run_${randomUUID()}`;
    this.startedAt = new Date().toISOString();

    this.parkedPromise = new Promise<void>((resolve) => {
      this.parkResolve = resolve;
    });
    this.settledPromise = new Promise<LiveRunOutcome>((resolve) => {
      this.settleResolve = resolve;
    });

    this.gate = new LivePolicyGate(
      options.policyEngine,
      options.registry,
      {
        sessionId: this.sessionId,
        runId: this.runId,
        emit: (type, data) => this.emit(type, data),
        recordRequest: (request) => {
          this.approvalCount += 1;
          this.permissions.set(request.requestId, {
            requestId: request.requestId,
            toolName: request.toolName,
            title: request.title,
            arguments: request.arguments,
            policyId: request.policyId,
          });
          this.options.store.approvals.request({
            sessionId: this.sessionId,
            runId: this.runId,
            requestId: request.requestId,
            toolName: request.toolName,
            arguments: request.arguments,
            policyId: request.policyId,
          });
          // The outstanding request is durable: the user may answer it
          // after a reconnect.
          this.options.store.requests.create({
            id: request.requestId,
            sessionId: this.sessionId,
            runId: this.runId,
            kind: 'permission',
            question: request.toolName,
          });
        },
        recordDecision: (decision) => {
          this.options.store.approvals.decide({
            requestId: decision.requestId,
            status: decision.status,
          });
          this.options.store.requests.answer({
            id: decision.requestId,
            answer: decision.status,
            status: 'resolved',
          });
        },
        awaitDecision: (requestId) => this.awaitDecision(requestId),
      },
    );
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Starts the run.
   *
   * It returns immediately: the run goes on in the background, and the
   * caller watches `parked` and `settled`.
   */
  start(): void {
    const { provider, registry, systemPrompt } = this.options;

    this.emit('run_started', {
      message: this.options.message,
      provider: provider.name,
      model: this.options.model ?? null,
    });

    const agent = new Agent({
      provider,
      registry,
      systemPrompt,
      approvalGate: this.gate,
      // Every tool goes through the policy engine: a policy may allow,
      // ask or deny any of them, and the default is by tool class.
      requiresDecision: () => true,
      prepareMessages: (messages) => this.prepareMessages(messages),
    });

    const context = {
      askUser: (request: { question: string; options?: string[] }) =>
        this.askUser(request),
    };

    void runInLiveContext(context, async () => {
      try {
        const result = await agent.run({
          history: this.options.history,
          userMessage: this.options.message,
          approvalGate: this.gate,
          onEvent: (event) => this.onAgentEvent(event),
          stream: true,
        });

        this.emit('message_complete', { text: this.accumulatedText_ });
        this.emit('run_finished', {
          outcome: 'completed',
          toolCallCount: this.toolCallCount,
          approvalCount: this.approvalCount,
          durationMs: Date.now() - new Date(this.startedAt).getTime(),
        });

        await this.flush(result.text);
        this.settle('completed');
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'The run failed.';
        this.emit('run_error', { message });
        await this.flush('', message);
        this.settle('error');
      }
    });
  }

  /**
   * Resolves when the run parks on a permission or a question.
   *
   * A run that finishes without parking resolves it too, so a caller can
   * always `await` it.
   */
  whenParked(): Promise<void> {
    return this.parkedPromise;
  }

  /** Resolves when the run is completely over. */
  whenSettled(): Promise<LiveRunOutcome> {
    return this.settledPromise;
  }

  /* ------------------------------------------------------------------ */
  /* The user's decisions                                                */
  /* ------------------------------------------------------------------ */

  /**
   * Records the user's decision on a permission.
   *
   * The decision reaches the parked run: the gate is waiting on exactly
   * this request.
   */
  decide(requestId: string, decision: 'allow' | 'deny'): boolean {
    const pending = this.decisions.get(requestId);
    if (!pending) return false;
    this.decisions.delete(requestId);
    pending.resolve(decision);
    return true;
  }

  /**
   * Records the user's answer to a question.
   *
   * The answer reaches the parked run.
   */
  answer(requestId: string, text: string): boolean {
    const pending = this.answers.get(requestId);
    if (!pending) return false;
    this.answers.delete(requestId);
    pending.resolve(text);
    return true;
  }

  /** The text the model produced, so far. */
  accumulatedText(): string {
    return this.accumulatedText_;
  }

  /**
   * The model's answer.
   *
   * It is the text of the last turn, which is what the plain
   * request/response path returns. The accumulated text is what the
   * socket's `message_complete` frame carries.
   */
  finalText(): string {
    for (let index = this.agentEventLog.length - 1; index >= 0; index -= 1) {
      const event = this.agentEventLog[index]!;
      if (event.type === 'text') return event.text;
    }
    return this.accumulatedText_;
  }

  /**
   * The agent's events, without the streaming ones.
   *
   * The deltas are for the socket: the REST payload carries the same
   * events the old client already knows.
   */
  agentEvents(): AgentEvent[] {
    return this.agentEventLog.filter(
      (event) => event.type !== 'text_delta' && event.type !== 'thinking',
    );
  }

  /** The permissions this run is waiting for. */
  pendingDecisionIds(): string[] {
    return [...this.decisions.keys()];
  }

  /**
   * The permission a request id refers to.
   *
   * It is what a remembered decision is turned into a policy from: the
   * same tool, the same arguments the user saw.
   */
  permissionFor(requestId: string): {
    requestId: string;
    toolName: string;
    title: string;
    arguments: Record<string, unknown>;
    policyId: string | null;
  } | null {
    return this.permissions.get(requestId) ?? null;
  }

  /** The questions this run is waiting for. */
  pendingAnswerIds(): string[] {
    return [...this.answers.keys()];
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Compacts the conversation when it has grown too long.
   *
   * The list is never reordered and never re-summarised in place: the
   * summary goes in front of the kept messages, and the kept messages
   * keep their order. That is what keeps the provider's cached prefix
   * matching.
   */
  private async prepareMessages(
    messages: ProviderMessage[],
  ): Promise<ProviderMessage[]> {
    const limit = await this.options.contextLimit?.();
    if (!limit || limit.inputTokens <= 0) return messages;

    const counted = (await this.options.countTokens?.(messages)) ?? undefined;

    if (
      !shouldCompact(messages, {
        inputLimit: limit.inputTokens,
        threshold: this.options.compactionThreshold,
        countedTokens: counted,
      })
    ) {
      return messages;
    }

    const summary = await summarise(this.options.provider, messages, {
      previousSummary: this.previousSummary,
    });

    // A summary that could not be produced leaves the list alone: the
    // run continues and the provider decides what to do about the size.
    if (!summary) return messages;

    this.previousSummary = summary;

    return compactMessages(messages, {
      inputLimit: limit.inputTokens,
      threshold: this.options.compactionThreshold,
      keepTurns: this.options.compactionKeepTurns,
      summary,
    });
  }

  /**
   * Asks the user a question and parks until they answer.
   *
   * This is what the `ask_user` tool calls.
   */
  private async askUser(request: {
    question: string;
    options?: string[];
  }): Promise<string> {
    const requestId = `req_${randomUUID()}`;

    this.options.store.requests.create({
      id: requestId,
      sessionId: this.sessionId,
      runId: this.runId,
      kind: 'clarification',
      question: request.question,
      options: request.options ?? null,
    });

    this.emit('clarification_requested', {
      requestId,
      question: request.question,
      options: request.options ?? undefined,
    });

    this.markParked();

    const answer = await new Promise<string>((resolve) => {
      this.answers.set(requestId, { resolve });
    });

    this.options.store.requests.answer({ id: requestId, answer });

    this.emit('clarification_answered', { requestId, answer });

    return answer;
  }

  /** Waits for the user's decision on a permission. */
  private awaitDecision(requestId: string): Promise<'allow' | 'deny'> {
    this.markParked();
    return new Promise<'allow' | 'deny'>((resolve) => {
      this.decisions.set(requestId, { resolve });
    });
  }

  /** Records that the run is waiting for the user. */
  private markParked(): void {
    if (this.parked) return;
    this.parked = true;
    this.parkResolve?.();
    this.parkResolve = null;
  }

  /** Publishes a frame and keeps it in the run's buffer. */
  private emit(type: LiveEventType, data: unknown): void {
    const frame = this.options.publish(type, data);
    this.frames.push({
      seq: frame.seq,
      runId: frame.runId,
      type: frame.type,
      data: frame.data,
      ts: frame.ts,
    });

    if (type === 'permission_requested' && data && typeof data === 'object') {
      const frame = data as Record<string, unknown>;
      // A permission that a policy already answered is not outstanding.
      // Parking on it would leave the run waiting for a decision that is
      // never going to come.
      if (frame.autoResolved !== true) {
        this.lastPermission = frame;
      }
    }
  }

  /**
   * The permission the run is parked on, in the shape the REST API uses.
   *
   * It is the same information the `permission_requested` frame carried,
   * so the old client and the new one agree.
   */
  pendingPermission(): {
    callId: string;
    requestId: string;
    name: string;
    title: string;
    description?: string;
    arguments: Record<string, unknown>;
    message: string;
    reason?: string;
    matchedPolicy?: string | null;
  } | null {
    if (!this.lastPermission) return null;

    const requestId = String(this.lastPermission.requestId ?? '');
    const name = String(this.lastPermission.tool ?? '');
    const title = String(this.lastPermission.title ?? name);
    const reason = String(this.lastPermission.reason ?? '');

    return {
      callId: requestId,
      requestId,
      name,
      title,
      description:
        typeof this.lastPermission.description === 'string'
          ? this.lastPermission.description
          : undefined,
      arguments:
        this.lastPermission.arguments &&
        typeof this.lastPermission.arguments === 'object'
          ? (this.lastPermission.arguments as Record<string, unknown>)
          : {},
      message: reason || title,
      reason: reason || undefined,
      matchedPolicy:
        typeof this.lastPermission.matchedPolicy === 'string'
          ? this.lastPermission.matchedPolicy
          : null,
    };
  }

  /** Turns an agent event into a frame. */
  private onAgentEvent(event: AgentEvent): void {
    this.agentEventLog.push(event);

    switch (event.type) {
      case 'thinking':
        this.emit('thinking_delta', { text: event.text });
        break;

      case 'text_delta':
        this.accumulatedText_ += event.text;
        this.emit('message_delta', { text: event.text });
        break;

      case 'tool_call':
        this.toolCallCount += 1;
        this.emit('tool_call_started', {
          callId: event.id,
          name: event.name,
          arguments: event.arguments,
        });
        break;

      case 'tool_result':
        this.emit('tool_call_completed', {
          callId: event.id,
          name: event.name,
          summary: event.result.summary,
          data: event.result.data ?? null,
          ok: event.ok,
        });
        break;

      case 'text': {
        // A whole text event, not a delta. The agent emits one of these
        // when it asks the model for a final summary after running out of
        // tool rounds. It is the answer, so it must reach the outcome.
        this.accumulatedText_ += event.text;
        this.emit('message_delta', { text: event.text });
        break;
      }

      default:
        // The rest of the agent's events are internal: the frames that
        // matter are the ones the protocol names.
        break;
    }
  }

  /**
   * Flushes the run to SQLite.
   *
   * The messages, the events and the run row are written in one go, at
   * the end of the run. While the run is going, the frames live in
   * memory — the database is not the live channel.
   */
  private async flush(text: string, error?: string): Promise<void> {
    const store = this.options.store;

    try {
      store.sessions.touch(this.sessionId);

      store.messages.append({
        sessionId: this.sessionId,
        role: 'user',
        content: this.options.message,
      });

      if (text) {
        store.messages.append({
          sessionId: this.sessionId,
          role: 'assistant',
          content: text,
        });
      }

      store.events.appendMany(
        this.frames.map((frame) => ({
          sessionId: this.sessionId,
          seq: frame.seq,
          runId: frame.runId,
          type: frame.type,
          data: frame.data,
          createdAt: frame.ts,
        })),
      );

      store.runs.start({
        id: this.runId,
        sessionId: this.sessionId,
        startedAt: this.startedAt,
      });
      store.runs.finish({
        id: this.runId,
        outcome: error ? 'error' : 'completed',
        error: error ?? null,
        toolCallCount: this.toolCallCount,
        approvalCount: this.approvalCount,
        finishedAt: new Date().toISOString(),
      });
    } catch {
      // A database that will not write must not take the run down: the
      // user is still watching the live stream.
    }
  }

  /** Finishes the run. */
  private settle(outcome: LiveRunOutcome): void {
    this.markParked();
    this.settleResolve?.(outcome);
    this.settleResolve = null;
  }
}
