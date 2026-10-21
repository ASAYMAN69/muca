import { z } from 'zod';

/**
 * A tool that Muca can discover and invoke over MCP.
 *
 * Two independent axes describe a tool's risk:
 *
 *   - `destructive` marks actions that change state in a way the user
 *     cannot trivially undo. The agent refuses to run those without an
 *     explicit confirmation from the user.
 *   - `writes` marks actions that change state **at all** — they create
 *     something. A write is not necessarily destructive: opening an issue
 *     writes, but it is not a consequential act.
 *
 * Keeping them separate matters because MCP publishes both as tool
 * annotations (`destructiveHint` and `readOnlyHint`), and a client uses
 * `readOnlyHint` to decide whether a call is safe to make unattended.
 * Deriving `readOnlyHint` from `destructive` would publish every
 * non-destructive write as read-only, which is a protocol lie.
 */
export interface MucaTool {
  name: string;
  title: string;
  description: string;
  /** Zod object schema describing the accepted arguments. */
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Marks a consequential action that requires user confirmation. */
  destructive: boolean;
  /**
   * Marks an action that changes state — it creates or modifies
   * something. Defaults to `false` (a read-only tool).
   */
  writes: boolean;
  /**
   * The handler receives the *parsed* arguments.
   *
   * The parameter is typed as `any` on purpose: the registry holds tools
   * with different schemas side by side, and a per-schema generic would
   * not survive that heterogeneity. Type safety at the definition site is
   * enforced by `defineTool` in `tools/index.ts`; runtime safety is
   * enforced by `inputSchema.safeParse` at every call boundary.
   */
  handler: (args: any) => Promise<ToolResult> | ToolResult;
}
export interface ToolResult {
  /** Human/AI readable summary of what happened. */
  summary: string;
  /** Optional machine-readable payload returned as `structuredContent`. */
  data?: unknown;
  /** When true the call should be surfaced to the user for confirmation first. */
  requiresConfirmation?: boolean;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * Registry of all tools exposed by the MCP server.
 *
 * Kept deliberately simple: a plain map plus lookup helpers. No dynamic
 * registration, no plugin system — the hackathon build needs to be readable
 * end to end.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, MucaTool>();

  register(tool: MucaTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  registerAll(tools: MucaTool[]): this {
    for (const tool of tools) this.register(tool);
    return this;
  }

  get(name: string): MucaTool | undefined {
    return this.tools.get(name);
  }

  list(): MucaTool[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}
