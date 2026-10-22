import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';

import type { ContextLimit } from '../ai/context-limits.js';
import type { AIProvider, ProviderMessage } from '../ai/provider.js';
import { PolicyEngine } from '../policy/engine.js';
import type { MucaStore } from '../store/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { LiveHub } from './hub.js';
import { LiveRun, type LiveRunOptions } from './run.js';
import { LiveSocketServer } from './ws-server.js';

/**
 * The live service.
 *
 * It owns the hub, the socket server and the runs, and it is the one
 * place that knows how a frame from the browser becomes a decision for
 * a parked run.
 */
export interface LiveServiceOptions {
  store: MucaStore;
  provider: AIProvider | null;
  /** The registry the MCP server and the REST catalogue use. */
  registry: ToolRegistry;
  /** The registry the live agent uses. It has the question tool in it. */
  liveRegistry: ToolRegistry;
  systemPrompt: string;
  /** The model, for the `run_started` frame. */
  model?: string | null;
  /** The path the socket is served at. */
  path?: string;
  /** The model's input limit, resolved at startup. */
  contextLimit?: () => Promise<ContextLimit | null>;
  /** The exact number of input tokens, when the provider can count them. */
  countTokens?: (messages: ProviderMessage[]) => Promise<number | null>;
  /** The fraction of the limit at which a conversation is compacted. */
  compactionThreshold?: number;
  /** How many turns are kept verbatim when a conversation is compacted. */
  compactionKeepTurns?: number;
}

export class LiveService {
  readonly hub: LiveHub;
  readonly sockets: LiveSocketServer;

  private readonly options: LiveServiceOptions;
  private readonly policyEngine: PolicyEngine;
  private readonly runs = new Map<string, LiveRun>();

  constructor(options: LiveServiceOptions) {
    this.options = options;
    this.hub = new LiveHub(options.store.events);
    this.policyEngine = new PolicyEngine(options.store.policies);

    this.sockets = new LiveSocketServer({
      hub: this.hub,
      path: options.path,
      onDecide: (input) => {
        this.decide(input);
      },
      onAnswer: (input) => {
        this.answer(input);
      },
    });
  }

  /** Attaches the socket to the existing HTTP server. */
  attach(httpServer: HttpServer): void {
    this.sockets.attach(httpServer);
  }

  /** Closes the sockets. */
  close(): Promise<void> {
    return this.sockets.close();
  }

  /**
   * The session a run belongs to.
   *
   * An explicit session id always wins. Without one, the run goes to
   * the session the browser is watching, so the user sees it live.
   */
  resolveSession(explicit?: string | null): string | null {
    if (explicit && explicit.trim() !== '') return explicit.trim();

    const active = this.hub.activeSessionIds();
    if (active.length === 1) return active[0]!;
    if (active.length > 1) return this.hub.activeSessionId;

    return this.hub.activeSessionId;
  }

  /**
   * Starts a live run.
   *
   * The run goes on in the background: the caller watches `whenParked`
   * and `whenSettled`.
   */
  start(input: {
    sessionId: string;
    message: string;
    history: ProviderMessage[];
  }): LiveRun | null {
    const provider = this.options.provider;
    if (!provider) return null;

    // The session must exist before anything is written to it.
    this.options.store.sessions.create({ id: input.sessionId });

    // The run gets its id here, not inside the run, because every frame
    // it publishes has to carry it. A frame without a run id cannot be
    // placed in a client's timeline, so the client would show the same
    // request once per frame instead of once per run.
    const runId = `run_${randomUUID()}`;

    const runOptions: LiveRunOptions = {
      sessionId: input.sessionId,
      message: input.message,
      history: input.history,
      provider,
      registry: this.options.liveRegistry,
      systemPrompt: this.options.systemPrompt,
      policyEngine: this.policyEngine,
      store: this.options.store,
      model: this.options.model ?? null,
      runId,
      publish: (type, data) =>
        this.hub.publish(input.sessionId, type, data, runId),
      contextLimit: this.options.contextLimit,
      countTokens: this.options.countTokens,
      compactionThreshold: this.options.compactionThreshold,
      compactionKeepTurns: this.options.compactionKeepTurns,
    };

    const run = new LiveRun(runOptions);
    this.runs.set(input.sessionId, run);

    // The run is dropped when it ends, so a session does not accumulate
    // finished runs.
    void run.whenSettled().then(() => {
      if (this.runs.get(input.sessionId) === run) {
        this.runs.delete(input.sessionId);
      }
    });

    run.start();
    return run;
  }

  /** The run of a session, if it is still going. */
  run(sessionId: string): LiveRun | undefined {
    return this.runs.get(sessionId);
  }

  /**
   * Records the user's decision on a permission.
   *
   * The decision reaches the parked run. When the user asked to
   * *remember* it, a global policy is created first, so the tool runs
   * under the new policy.
   */
  decide(input: {
    sessionId: string;
    requestId: string;
    decision: 'allow' | 'deny';
    remember: boolean;
  }): boolean {
    const run = this.runs.get(input.sessionId);
    if (!run) return false;

    const permission = run.permissionFor(input.requestId);

    if (input.remember && input.decision === 'allow' && permission) {
      this.rememberPermission(permission);
    }

    return run.decide(input.requestId, input.decision);
  }

  /** Records the user's answer to a question. */
  answer(input: {
    sessionId: string;
    requestId: string;
    text: string;
  }): boolean {
    const run = this.runs.get(input.sessionId);
    if (!run) return false;
    return run.answer(input.requestId, input.text);
  }

  /**
   * Turns a remembered decision into a policy.
   *
   * The policy is **global**: it applies to every session. It matches
   * the same tool and the same arguments the user approved, and it
   * allows them.
   */
  private rememberPermission(permission: {
    toolName: string;
    title: string;
    arguments: Record<string, unknown>;
  }): void {
    const match = matchFromArguments(permission.arguments);
    const label = `Always allow ${permission.toolName}`;

    this.options.store.policies.create({
      toolName: permission.toolName,
      match,
      effect: 'allow',
      sessionId: null,
      label,
    });
  }
}

/**
 * The argument matchers for a remembered decision.
 *
 * Every argument the user saw is spelled out, so the policy allows
 * exactly that action and not every action of the same tool.
 */
export function matchFromArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const match: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;

    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      match[name] = { equals: value };
      continue;
    }

    if (
      Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean',
      )
    ) {
      match[name] = { equals: value };
    }
  }

  return match;
}
