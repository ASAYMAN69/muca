import { z } from 'zod';

import { ToolError, type MucaTool, type ToolResult } from './registry.js';
import { createOpsTools } from './ops/index.js';
import { createMockOpsAdapters } from './ops/mock.js';
import type { OpsAdapters } from './ops/types.js';

/**
 * Muca's tool set: the **Ops Copilot**.
 *
 * Muca triages deployment and CI failures for solo developers and small
 * teams: it reads the evidence (deployments, CI runs, issues), forms a
 * diagnosis, and — only after the user approves it — opens a branch and a
 * pull request.
 *
 * The domain adapters are seeded mocks, so the whole flow runs with **no
 * external service credentials**. A real adapter implements the same
 * `OpsAdapters` interface and can be swapped in without touching a tool.
 *
 * See `tools/ops/` for the domain model and the mock implementation.
 */

/**
 * Builds a tool with its argument types inferred from the Zod schema.
 * The handler receives the parsed, typed arguments.
 */
function defineTool<Shape extends z.ZodRawShape>(config: {
  name: string;
  title: string;
  description: string;
  schema: z.ZodObject<Shape>;
  destructive?: boolean;
  /**
   * Marks a tool that changes state. It is independent of `destructive`:
   * a write is not necessarily a consequential act.
   */
  writes?: boolean;
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
  ) => Promise<ToolResult> | ToolResult;
}): MucaTool {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.schema,
    destructive: config.destructive ?? false,
    writes: config.writes ?? false,
    handler: config.handler as MucaTool['handler'],
  };
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const echoArgs = z.object({
  message: z.string().min(1).max(500),
  repeat: z.number().int().min(1).max(5).default(1),
});

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

export function createTools(adapters: OpsAdapters = createMockOpsAdapters()): MucaTool[] {
  return [
    /**
     * A connectivity check.
     *
     * It is the one tool that is not part of the Ops Copilot domain, and it
     * earns its place: it is the cheapest possible round trip through the
     * whole stack (transport -> schema validation -> handler -> result). A
     * judge or a new integrator can call it to prove the pipeline works
     * before touching the domain tools.
     */
    defineTool({
      name: 'echo',
      title: 'Echo',
      description:
        'Repeat a short message back to the caller. Used as a connectivity check: ' +
        'it proves the MCP transport, the schema validation and the tool result ' +
        'format all work end to end.',
      schema: echoArgs,
      handler: (args) => ({
        summary: Array.from({ length: args.repeat }, () => args.message).join(' '),
        data: { message: args.message, repeat: args.repeat },
      }),
    }),

    ...createOpsTools(adapters),
  ];
}

export { ToolError };
