import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  CreateTaskResult,
  GetTaskResult,
  Task,
} from '@modelcontextprotocol/sdk/types.js';

import { createDiagnosis } from '../tools/ops/index.js';
import type { OpsAdapters } from '../tools/ops/types.js';
import {
  TASK_BACKED_TOOLS,
  type TaskBackedTool,
} from '../tools/catalogue.js';

/**
 * MCP Tasks — the long-running half of the product.
 *
 * A full incident diagnosis is not instant: it correlates a deployment
 * with its CI run, walks the log, and matches an issue. Modelling that as
 * a synchronous `tools/call` would block the request for as long as it
 * takes, and the client would have no way to ask "how is it going?".
 *
 * MCP **Tasks** solve exactly that: the server returns a task handle
 * immediately, the work continues in the background, and the client polls
 * `tasks/get` for the status.
 *
 * The SDK's task status vocabulary is used verbatim:
 *
 *   | SDK status       | Meaning in Muca                      |
 *   |------------------|--------------------------------------|
 *   | `working`        | the diagnosis is running              |
 *   | `input_required` | waiting for a human decision          |
 *   | `completed`      | the diagnosis finished successfully   |
 *   | `failed`         | the diagnosis failed                  |
 *   | `cancelled`      | the client cancelled the task         |
 *
 * The SDK's `InMemoryTaskStore` is used for the state, so the SDK's own
 * `tasks/get`, `tasks/list` and `tasks/cancel` handlers are wired up for
 * us by the SDK.
 */

/** The status values the SDK uses. */
export type TaskStatus = Task['status'];

/** The status values that mean "this task will not change again". */
export const TERMINAL_TASK_STATUSES: TaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

/** True when the status is terminal. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

/** A snapshot of a task, in the shape the REST API returns. */
export interface TaskSnapshot {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  lastUpdatedAt: string;
  /** The status message, when the task set one. */
  statusMessage?: string;
  /** The result, once the task completed successfully. */
  result?: unknown;
  /** The error, once the task failed. */
  error?: string;
}

/** How long a diagnosis may run before it is abandoned. */
export const DEFAULT_TASK_TIMEOUT_MS = 60_000;

/** How long to wait between the background steps of a diagnosis. */
export const DEFAULT_TASK_TICK_MS = 20;

/**
 * The background runner for Muca's long-running work.
 *
 * It owns the timers so they can always be cleared: a task that is
 * cancelled, that times out, or that finishes does not leave a pending
 * timer behind.
 */
export class TaskRunner {
  private readonly timers = new Map<
    string,
    { timer: NodeJS.Timeout; resolve: () => void }
  >();
  private readonly cancelled = new Set<string>();

  constructor(readonly timeoutMs = DEFAULT_TASK_TIMEOUT_MS) {}

  /**
   * Runs `steps` one at a time, yielding between them.
   *
   * The task is marked cancelled if the runner is asked to stop, and fails
   * if it runs out of time.
   */
  async run(
    taskId: string,
    steps: Array<() => Promise<void> | void>,
    onDone: () => Promise<void> | void,
  ): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;

    try {
      for (const step of steps) {
        if (this.cancelled.has(taskId)) return;

        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`Task ${taskId} timed out after ${this.timeoutMs}ms`);
        }

        await this.delay(taskId, Math.min(DEFAULT_TASK_TICK_MS, remaining));
        if (this.cancelled.has(taskId)) return;

        if (Date.now() >= deadline) {
          throw new Error(`Task ${taskId} timed out after ${this.timeoutMs}ms`);
        }

        await step();
      }

      if (this.cancelled.has(taskId)) return;
      await onDone();
    } finally {
      this.timers.delete(taskId);
      this.cancelled.delete(taskId);
    }
  }

  /** Marks a task as cancelled. Its pending timer is cleared. */
  cancel(taskId: string): void {
    this.cancelled.add(taskId);
    this.clearTimer(taskId);
  }

  /** Cancels every running task. Called on shutdown. */
  cancelAll(): void {
    for (const taskId of [...this.timers.keys()]) {
      this.cancel(taskId);
    }
  }

  /** The number of live timers. Used by the tests to prove nothing leaks. */
  get activeTimerCount(): number {
    return this.timers.size;
  }

  /**
   * Waits for `ms` milliseconds.
   *
   * The promise always settles: `cancel` clears the timer *and* resolves
   * the promise, so a cancelled task never hangs.
   */
  private delay(taskId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(taskId);
        resolve();
      }, ms);
      this.timers.set(taskId, { timer, resolve });
    });
  }

  private clearTimer(taskId: string): void {
    const entry = this.timers.get(taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.timers.delete(taskId);
    // Let the awaiting `delay` continue so the loop can notice the
    // cancellation and unwind.
    entry.resolve();
  }
}

/**
 * The long-running diagnosis tool.
 *
 * `diagnose_incident` correlates a deployment, its CI run and the matching
 * issue into one incident, over several ticks. It is registered through
 * `server.experimental.tasks.registerToolTask`, so a client that asks for
 * a task gets a handle immediately instead of a blocking response.
 *
 * The tool's *metadata* — its name, title, description and input schema —
 * is declared once in `src/tools/catalogue.ts`, so the MCP `tools/list`
 * result and the REST catalogue cannot drift apart. This module owns the
 * *behaviour*; the catalogue owns the *description*.
 */
export { DIAGNOSE_TOOL_NAME } from '../tools/catalogue.js';

export interface DiagnosisTaskDeps {
  adapters: OpsAdapters;
  runner: TaskRunner;
}

/**
 * Registers the task-backed tools on an MCP server.
 *
 * The server must have been constructed with a `taskStore`, otherwise the
 * SDK has nowhere to put the task state.
 */
export function registerTaskTools(
  server: McpServer,
  deps: DiagnosisTaskDeps,
): void {
  const diagnose = createDiagnosis(deps.adapters);

  for (const tool of TASK_BACKED_TOOLS) {
    registerTaskTool(server, tool, deps, diagnose);
  }
}

/** Registers one task-backed tool from the catalogue. */
function registerTaskTool(
  server: McpServer,
  tool: TaskBackedTool,
  deps: DiagnosisTaskDeps,
  diagnose: ReturnType<typeof createDiagnosis>,
): void {
  server.experimental.tasks.registerToolTask(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        title: tool.title,
      },
      // `optional` means: a client that does not support tasks still gets
      // a normal (blocking) call, and a client that does get a task handle.
      execution: { taskSupport: 'optional' },
    },
    {
      createTask: async (args, extra) => {
        const task = await extra.taskStore.createTask({
          ttl: deps.runner.timeoutMs,
        });

        const { deploymentId, service } = args as {
          deploymentId?: string;
          service?: string;
        };

        // The work continues in the background; the handle is returned now.
        void deps.runner
          .run(
            task.taskId,
            [
              // Tick 1: locate the deployment.
              async () => {
                await extra.taskStore.updateTaskStatus(
                  task.taskId,
                  'working',
                  'Locating the deployment…',
                );
              },
              // Tick 2: correlate the CI run.
              async () => {
                await extra.taskStore.updateTaskStatus(
                  task.taskId,
                  'working',
                  'Correlating the CI run…',
                );
              },
              // Tick 3: write the diagnosis and store the result.
              async () => {
                const incident = diagnose({ deploymentId, service });
                await extra.taskStore.updateTaskStatus(
                  task.taskId,
                  'working',
                  'Writing the diagnosis…',
                );
                await extra.taskStore.storeTaskResult(task.taskId, 'completed', {
                  content: [
                    {
                      type: 'text',
                      text:
                        `${incident.title}\n${incident.summary}\n\n` +
                        `Likely cause: ${incident.likelyCause}\n` +
                        `Next action: ${incident.recommendedAction}\n` +
                        `Evidence: ${incident.evidence.join(', ')}`,
                    },
                  ],
                  structuredContent: incident as unknown as Record<string, unknown>,
                });
              },
            ],
            () => {
              // Nothing more to do — the last step stored the result.
            },
          )
          .catch(async (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            try {
              await extra.taskStore.updateTaskStatus(
                task.taskId,
                'failed',
                message,
              );
              await extra.taskStore.storeTaskResult(task.taskId, 'failed', {
                content: [{ type: 'text', text: `Diagnosis failed: ${message}` }],
                isError: true,
              });
            } catch {
              // The task is already gone; nothing more to do.
            }
          });

        return { task } as CreateTaskResult;
      },

      getTask: async (_args, extra) => {
        return (await extra.taskStore.getTask(extra.taskId)) as GetTaskResult;
      },

      getTaskResult: async (_args, extra) => {
        return (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult;
      },
    },
  );
}