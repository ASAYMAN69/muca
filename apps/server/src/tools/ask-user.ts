import { z } from 'zod';

import { currentLiveContext } from '../live/context.js';
import type { MucaTool, ToolResult } from './registry.js';

/**
 * The tool the model uses to ask the user a question.
 *
 * The model cannot answer its own questions, and it cannot see the
 * browser. So it asks here, the server turns the call into a
 * `clarification_requested` event, and the run is parked until the user
 * answers.
 *
 * The tool is **not** part of the MCP surface. An MCP client has no way
 * to answer a question over the protocol, so a call there would hang
 * forever. It belongs to the live web path only.
 */

/** The name of the question tool. */
export const ASK_USER_TOOL_NAME = 'ask_user';

const askUserArgs = z.object({
  /** The question, in one or two sentences. */
  question: z.string().min(1, 'question must not be empty').max(1000),
  /** The answers the user can pick from, when there are obvious ones. */
  options: z.array(z.string().min(1).max(200)).max(10).optional(),
});

/**
 * Builds the question tool.
 *
 * It reads the live run out of the async context, so one registered tool
 * serves every run.
 */
export function createAskUserTool(): MucaTool {
  return {
    name: ASK_USER_TOOL_NAME,
    title: 'Ask the user',
    description:
      'Ask the user a question when you need something the tools cannot tell you — ' +
      'which environment to deploy to, which of two failures is the real one, what ' +
      'the acceptance criteria are. The run pauses until the user answers, so ask ' +
      'only when you genuinely cannot continue without the answer.',
    inputSchema: askUserArgs,
    // Asking is not writing, and it is not consequential: nothing changes.
    writes: false,
    destructive: false,
    handler: async (args: {
      question: string;
      options?: string[];
    }): Promise<ToolResult> => {
      const context = currentLiveContext();

      if (!context) {
        return {
          summary:
            'There is no user available to answer questions right now. ' +
            'Carry on with what you can determine from the tools.',
        };
      }

      const answer = await context.askUser({
        question: args.question,
        options: args.options,
      });

      return {
        summary: `The user answered: ${answer}`,
        data: { question: args.question, answer },
      };
    },
  };
}
