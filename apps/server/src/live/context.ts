import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The live run the current async work belongs to.
 *
 * A tool handler sometimes needs to talk to the run that called it — the
 * `ask_user` tool has to ask the user a question and wait for the
 * answer. The tool is registered once, for the whole server, so it
 * cannot be given the run as an argument.
 *
 * The async context is the clean way to do it: the run starts its work
 * inside `runInLiveContext`, and everything it calls — including the tool
 * handler — sees the same run.
 */
export interface LiveContext {
  /**
   * Asks the user a question and waits for the answer.
   *
   * The run is parked while it waits.
   */
  askUser(request: { question: string; options?: string[] }): Promise<string>;
}

const storage = new AsyncLocalStorage<LiveContext>();

/** Runs `fn` with the live run in context. */
export function runInLiveContext<T>(context: LiveContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** The live run of the current async work, if there is one. */
export function currentLiveContext(): LiveContext | undefined {
  return storage.getStore();
}
