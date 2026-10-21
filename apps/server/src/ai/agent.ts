import { z } from 'zod';

import {
  MucaTool,
  ToolRegistry,
  ToolError,
  type ToolResult,
} from '../tools/registry.js';
import {
  toolCallArgumentsSchema,
  type AIProvider,
  type ProviderMessage,
  type ProviderTool,
  type ProviderToolCall,
} from './provider.js';
import {
  HttpApprovalGate,
  isDeferrable,
  type ApprovalGate,
  type ApprovalRequest,
} from './approval-gate.js';
import { toProviderJsonSchema } from './json-schema.js';

export const MAX_TOOL_ROUNDS = 12;

export type AgentEvent =
  | { type: 'text'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }
  | { type: 'tool_result'; id: string; name: string; result: ToolResult }
  | {
      type: 'confirmation_required';
      callId: string;
      name: string;
      arguments: Record<string, unknown>;
      message: string;
    }
  | {
      type: 'approval_decision';
      callId: string;
      name: string;
      approved: boolean;
      source: 'elicitation' | 'http' | 'fallback';
    }
  | { type: 'error'; message: string };

export interface PendingCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  message: string;
}

export interface AgentRunResult {
  /** Final assistant text, empty if the run stopped awaiting confirmation. */
  text: string;
  /** Ordered list of everything that happened, for streaming to the UI. */
  events: AgentEvent[];
  /** True when the agent stopped to ask for user confirmation. */
  awaitingConfirmation: boolean;
  /** The tool call the agent is blocked on, if any. */
  pendingCall: PendingCall | null;
}

export interface AgentOptions {
  provider: AIProvider;
  registry: ToolRegistry;
  systemPrompt: string;
  maxRounds?: number;
  /**
   * The gate every destructive tool must pass.
   *
   * Defaults to the HTTP gate with nothing approved: a destructive call
   * parks the run and waits for the user. A destructive tool never runs
   * without a human decision.
   */
  approvalGate?: ApprovalGate;
}

/**
 * Muca's agent loop.
 *
 * The loop is deliberately explicit rather than framework-driven:
 *   1. Send the conversation + the tool catalogue to the model.
 *   2. If the model asked for tools, validate the arguments, run the tools.
 *   3. Feed the tool results back and repeat.
 *   4. Stop when the model answers without requesting tools.
 *
 * Consequential tools (`destructive: true`) are never executed without an
 * explicit user confirmation. When the model requests one, the loop pauses
 * and returns `awaitingConfirmation` with the pending call.
 */
export class Agent {
  private readonly provider: AIProvider;
  private readonly registry: ToolRegistry;
  private readonly systemPrompt: string;
  private readonly maxRounds: number;
  private readonly approvalGate: ApprovalGate;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.systemPrompt = options.systemPrompt;
    this.maxRounds = options.maxRounds ?? MAX_TOOL_ROUNDS;
    this.approvalGate = options.approvalGate ?? new HttpApprovalGate();
  }

  /** Tool catalogue in the provider-neutral shape. */
  toolCatalogue(): ProviderTool[] {
    return this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: toJsonSchema(tool.inputSchema),
    }));
  }

  /**
   * Runs the agent to completion.
   *
   * @param history  Prior conversation turns (user + assistant messages).
   * @param userMessage The new user request.
   * @param approvalGate The gate a destructive tool must pass. Defaults to
   *   the gate the agent was constructed with.
   * @param approvedCallIds Tool call ids the user has already approved.
   *   These are passed to the gate as *candidates*; the gate decides
   *   whether they actually authorise this call. The agent never honours
   *   a raw id on its own — the call id in a tool call comes from the
   *   model, not from the server, so an id the client invents could
   *   otherwise authorise an arbitrary destructive call.
   */
  async run(input: {
    history: ProviderMessage[];
    userMessage: string;
    approvalGate?: ApprovalGate;
    approvedCallIds?: string[];
  }): Promise<AgentRunResult> {
    const gate = input.approvalGate ?? this.approvalGate;
    const approved = new Set(input.approvedCallIds ?? []);
    const events: AgentEvent[] = [];

    const messages: ProviderMessage[] = [
      { role: 'system', content: this.systemPrompt },
      ...input.history,
      { role: 'user', content: input.userMessage },
    ];

    const tools = this.toolCatalogue();

    for (let round = 0; round < this.maxRounds; round++) {
      let response;
      try {
        response = await this.provider.chat({ messages, tools });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Provider request failed';
        events.push({ type: 'error', message });
        return { text: '', events, awaitingConfirmation: false, pendingCall: null };
      }

      if (response.content) {
        events.push({ type: 'text', text: response.content });
      }

      if (response.toolCalls.length === 0) {
        return {
          text: response.content ?? '',
          events,
          awaitingConfirmation: false,
          pendingCall: null,
        };
      }

      // Record the assistant turn that requested the tools.
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls,
      });

      for (const call of response.toolCalls) {
        const parsed = this.parseArguments(call);

        if (!parsed.ok) {
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: `Invalid arguments: ${parsed.error}`,
          });
          events.push({ type: 'error', message: parsed.error });
          continue;
        }

        const tool = this.registry.get(call.name);
        if (!tool) {
          const message = `Unknown tool: ${call.name}`;
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content: message,
          });
          events.push({ type: 'error', message });
          continue;
        }

        events.push({
          type: 'tool_call',
          id: call.id,
          name: call.name,
          arguments: parsed.args,
        });

        if (tool.destructive) {
          const approval: ApprovalRequest = {
            toolName: tool.name,
            title: tool.title,
            message: describeCall(tool.title, parsed.args),
            arguments: parsed.args,
          };

          const source = gate.source ?? 'fallback';

          // The gate is ALWAYS consulted for a destructive tool. It is
          // the only component that knows which approvals were actually
          // issued and what action they referred to.
          //
          // The agent deliberately does *not* honour a raw call id on
          // its own: the id in a tool call comes from the model, not
          // from the server, so an id a client invented (or a stale one)
          // must not be able to authorise an arbitrary destructive call.
          //
          // The `approvedCallIds` are therefore only *candidates*: the
          // gate resolves them against the approvals it was given, which
          // come from the server-side registry.
          const decision = await gate.request({
            approval,
            requestId: call.id,
            fallback: async () => approved.has(call.id),
          });

          if (!decision) {
            // The gate could not obtain a decision. If the gate says the
            // decision is still outstanding (the plain-HTTP path), the run
            // *parks*: it returns a pendingCall and the UI asks the user.
            // Otherwise this is a refusal, and the run continues without
            // the tool.
            if (isDeferrable(gate) && gate.isPending(call.id)) {
              // Record the decision before parking: the audit trail must
              // show that this call was *not* authorised, and the UI
              // needs to know an approval was asked for and withheld.
              events.push({
                type: 'approval_decision',
                callId: call.id,
                name: call.name,
                approved: false,
                source,
              });

              const confirmation: PendingCall = {
                callId: call.id,
                name: call.name,
                arguments: parsed.args,
                message: approval.message,
              };
              events.push({
                type: 'confirmation_required',
                callId: call.id,
                name: call.name,
                arguments: parsed.args,
                message: confirmation.message,
              });
              return {
                text: response.content ?? '',
                events,
                awaitingConfirmation: true,
                pendingCall: confirmation,
              };
            }

            events.push({
              type: 'approval_decision',
              callId: call.id,
              name: call.name,
              approved: false,
              source,
            });

            // The user said no. Tell the model, and move on — a refusal is
            // a normal outcome, not an error.
            const declined =
              `The user declined to run ${tool.name}. Do not retry it; explain what you would have done instead.`;
            messages.push({
              role: 'tool',
              toolCallId: call.id,
              name: call.name,
              content: declined,
            });
            events.push({ type: 'error', message: declined });
            continue;
          }

          events.push({
            type: 'approval_decision',
            callId: call.id,
            name: call.name,
            approved: true,
            source,
          });
        }

        const { result, error } = await this.executeTool(tool, parsed.args);
        if (error) {
          events.push({ type: 'error', message: error });
        }
        events.push({
          type: 'tool_result',
          id: call.id,
          name: call.name,
          result,
        });
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: result.summary,
        });
      }
    }

    // The round limit is a safety valve, not a verdict: by the time it is
    // reached the agent may already have everything it needs. A live run
    // did eight successful tool calls and then ended with an error and no
    // answer, which throws away work that was already done.
    //
    // So the loop asks the model for a final answer with the tools taken
    // away. It cannot do more work, it can only report what it found.
    const summary = await this.summarise(messages);

    if (summary) {
      events.push({ type: 'text', text: summary });
      return { text: summary, events, awaitingConfirmation: false, pendingCall: null };
    }

    const message = `Reached the maximum of ${this.maxRounds} tool rounds.`;
    events.push({ type: 'error', message });
    return { text: '', events, awaitingConfirmation: false, pendingCall: null };
  }

  /**
   * Asks the model for a final answer, with the tools taken away.
   *
   * Returns `null` when the provider cannot answer, so the caller can
   * fall back to reporting the limit.
   */
  private async summarise(messages: ProviderMessage[]): Promise<string | null> {
    try {
      const response = await this.provider.chat({
        messages: [
          ...messages,
          {
            role: 'user',
            content:
              'You have run out of tool calls. Summarise what you found, ' +
              'using the tool results above, and answer the original ' +
              'question. Do not call any more tools.',
          },
        ],
        tools: [],
      });

      const text = response.content?.trim();
      return text && text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  private parseArguments(
    call: ProviderToolCall,
  ): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(call.arguments || '{}');
    } catch {
      return { ok: false, error: `Arguments for ${call.name} are not valid JSON.` };
    }

    const parsed = toolCallArgumentsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Arguments for ${call.name} must be a JSON object.`,
      };
    }
    return { ok: true, args: parsed.data };
  }

  private async executeTool(
    tool: MucaTool,
    args: Record<string, unknown>,
  ): Promise<{ result: ToolResult; error?: string }> {
    const validated = tool.inputSchema.safeParse(args);
    if (!validated.success) {
      const message = `Invalid arguments for ${tool.name}: ${formatZodError(validated.error)}`;
      return {
        result: { summary: message },
        error: message,
      };
    }

    try {
      return { result: await tool.handler(validated.data) };
    } catch (error) {
      if (error instanceof ToolError) {
        return { result: { summary: `Error: ${error.message}` }, error: error.message };
      }
      const message =
        error instanceof Error ? error.message : 'Unknown tool failure';
      return { result: { summary: `Error: ${message}` }, error: message };
    }
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function describeCall(title: string, args: Record<string, unknown>): string {
  const rendered = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(', ');
  return rendered ? `${title} (${rendered})` : title;
}

/**
 * Converts a Zod v4 object schema into a provider-safe JSON Schema object.
 *
 * The conversion is centralised in `json-schema.ts`, because a provider
 * accepts a schema *dialect*, not a complete JSON Schema document: Zod's
 * `$schema` keyword alone makes the live Gemini API reject the request
 * with HTTP 400.
 */
function toJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  return toProviderJsonSchema(schema);
}
