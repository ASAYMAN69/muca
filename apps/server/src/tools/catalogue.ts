import { z } from 'zod';

import type { MucaTool } from './registry.js';

/**
 * The tool catalogue — the **single source of truth** for Muca's tool
 * surface.
 *
 * Muca's headline claim is that every capability is a real MCP tool. For
 * that claim to hold, every surface that reports the tool list must
 * report the *same* list: the MCP `tools/list` result, `GET /api/v1/tools`
 * and `GET /api/v1/health`.
 *
 * This module is where the list is declared. The MCP layer and the REST
 * layer both derive from it, so they cannot drift apart.
 *
 * There are two kinds of tool:
 *
 *   - **Registry tools** — the ordinary ones, implemented by a handler in
 *     `src/tools/` and invoked synchronously.
 *   - **Task-backed tools** — protocol-level tools that are *not* plain
 *     `tools/call` handlers. They are registered with the MCP SDK's
 *     experimental Tasks API and return a **task handle** that the client
 *     polls with `tasks/get`. `diagnose_incident` is the one today.
 *
 * The distinction is published honestly: a task-backed tool is marked
 * `taskBacked: true`, so a REST consumer is never told that it returns a
 * plain result when it actually returns a handle.
 */

/** How a tool is invoked. */
export type ToolInvocation =
  | { kind: 'sync' }
  | { kind: 'task'; /** The MCP `tasks/*` lifecycle backs this tool. */ };

/**
 * A uniform description of one tool, whatever kind it is.
 *
 * This is what the REST layer reports and what the MCP layer registers
 * from, so the two can never disagree.
 */
export interface CatalogueEntry {
  name: string;
  title: string;
  description: string;
  /** The tool's input arguments, as a JSON Schema-ish object. */
  inputSchema: Record<string, unknown>;
  /** True when the tool changes state irreversibly. */
  destructive: boolean;
  /** How the tool is invoked. */
  invocation: ToolInvocation;
}

/* -------------------------------------------------------------------------- */
/* The task-backed tool                                                       */
/* -------------------------------------------------------------------------- */

/** The name of the long-running diagnosis tool. */
export const DIAGNOSE_TOOL_NAME = 'diagnose_incident';

/**
 * The input schema of the diagnosis tool.
 *
 * It lives here, next to the catalogue, so the description the REST API
 * publishes and the schema the MCP server registers are the same object.
 */
export const DIAGNOSE_INPUT_SCHEMA = {
  service: z
    .string()
    .min(1)
    .max(80)
    .optional()
    .describe('The service to diagnose. Omit to use the most recent deployment.'),
  deploymentId: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('A specific deployment to diagnose.'),
};

export const DIAGNOSE_TITLE = 'Diagnose incident';

export const DIAGNOSE_DESCRIPTION =
  'Correlate a failing deployment with its CI run and the matching issue, ' +
  'then return a diagnosis: likely cause, evidence and the next action. ' +
  'This is long-running, so it returns a task handle that can be polled ' +
  'for status with tasks/get.';

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The protocol-level (task-backed) tools, declared once.
 *
 * Each entry carries everything both the MCP layer and the REST layer
 * need, so neither has to repeat it.
 */
export interface TaskBackedTool {
  name: string;
  title: string;
  description: string;
  /** The Zod raw shape the MCP server registers. */
  inputSchema: Record<string, z.ZodTypeAny>;
}

/**
 * The task-backed tools Muca exposes.
 *
 * This is the list the MCP layer registers with the SDK's Tasks API and
 * the list the REST layer reports — one declaration, two consumers.
 */
export const TASK_BACKED_TOOLS: readonly TaskBackedTool[] = [
  {
    name: DIAGNOSE_TOOL_NAME,
    title: DIAGNOSE_TITLE,
    description: DIAGNOSE_DESCRIPTION,
    inputSchema: DIAGNOSE_INPUT_SCHEMA,
  },
];

/**
 * The task-backed tool with a given name, if there is one.
 */
export function findTaskBackedTool(name: string): TaskBackedTool | undefined {
  return TASK_BACKED_TOOLS.find((tool) => tool.name === name);
}

/**
 * Builds the full catalogue.
 *
 * @param registryTools The ordinary tools, from the `ToolRegistry`.
 * @param taskTools The protocol-level tools. Defaults to
 *   `TASK_BACKED_TOOLS`.
 */
export function buildCatalogue(
  registryTools: MucaTool[],
  taskTools: readonly TaskBackedTool[] = TASK_BACKED_TOOLS,
): CatalogueEntry[] {
  const entries: CatalogueEntry[] = registryTools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema.shape as Record<string, unknown>,
    destructive: tool.destructive,
    invocation: { kind: 'sync' },
  }));

  for (const tool of taskTools) {
    entries.push({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      destructive: false,
      invocation: { kind: 'task' },
    });
  }

  return entries;
}

/**
 * The wire shape of one catalogue entry.
 *
 * `taskBacked` is **additive**: a consumer that ignores it keeps working,
 * and a consumer that reads it knows the tool returns a task handle
 * rather than a plain result.
 */
export interface CatalogueEntryJson {
  name: string;
  title: string;
  description: string;
  destructive: boolean;
  inputSchema: Record<string, unknown>;
  /** True when the tool is backed by the MCP Tasks lifecycle. */
  taskBacked: boolean;
}

/** Renders a catalogue entry for the REST API. */
export function toJson(entry: CatalogueEntry): CatalogueEntryJson {
  return {
    name: entry.name,
    title: entry.title,
    description: entry.description,
    destructive: entry.destructive,
    inputSchema: entry.inputSchema,
    taskBacked: entry.invocation.kind === 'task',
  };
}

/**
 * Renders a catalogue entry for `GET /api/v1/health`.
 *
 * The health endpoint has always reported a compact summary. It gains
 * only the `taskBacked` marker, so a consumer can tell a task-backed
 * tool from an ordinary one without a second request.
 */
export interface HealthToolJson {
  name: string;
  title: string;
  description: string;
  destructive: boolean;
  taskBacked: boolean;
}

/** Renders a catalogue entry for the health endpoint. */
export function toHealthJson(entry: CatalogueEntry): HealthToolJson {
  return {
    name: entry.name,
    title: entry.title,
    description: entry.description,
    destructive: entry.destructive,
    taskBacked: entry.invocation.kind === 'task',
  };
}
