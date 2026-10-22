import type { AIProvider, ProviderMessage } from './provider.js';

/**
 * Compaction.
 *
 * A long session has to be summarised before it reaches the model's
 * input limit. The rule is narrow and deliberate: the summary replaces
 * the **old text**, and the things that would be expensive to lose are
 * kept exactly as they were.
 *
 * What is kept:
 *
 *   - the last **3** turns, verbatim;
 *   - every tool call and its result;
 *   - the pending approval and request state;
 *   - every deployment id, CI run id and issue number already seen.
 *
 * Losing an id loses the trail: the model can no longer fetch the
 * deployment the user is talking about.
 */
export interface CompactionOptions {
  /** The model's input limit, in tokens. */
  inputLimit: number;
  /** The fraction of the limit at which compaction triggers. */
  threshold?: number;
  /** How many turns are kept verbatim. */
  keepTurns?: number;
  /** The summary of the conversation so far. */
  summary: string;
}

/** The default fraction of the input limit at which compaction happens. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.8;

/** The default number of turns kept verbatim. */
export const DEFAULT_KEEP_TURNS = 3;

/**
 * The estimated number of input tokens.
 *
 * Four characters per token is the usual rule of thumb. It is an
 * estimate, and it is only used when the provider cannot count.
 */
export function estimateTokens(messages: ProviderMessage[]): number {
  let characters = 0;

  for (const message of messages) {
    characters += (message.content ?? '').length;
    for (const call of message.toolCalls ?? []) {
      characters += call.name.length + call.arguments.length;
    }
  }

  return Math.ceil(characters / 4);
}

/**
 * Whether the conversation has grown past the point of comfort.
 *
 * The threshold is a fraction of the model's input limit, so a model
 * with a small window compacts earlier.
 */
export function shouldCompact(
  messages: ProviderMessage[],
  options: { inputLimit: number; threshold?: number; countedTokens?: number },
): boolean {
  if (options.inputLimit <= 0) return false;

  const threshold = options.threshold ?? DEFAULT_COMPACTION_THRESHOLD;
  const limit = Math.floor(options.inputLimit * threshold);

  // The counted tokens are exact, so they are preferred; the estimate is
  // the fallback.
  const tokens = options.countedTokens ?? estimateTokens(messages);

  return tokens >= limit;
}

/** The identifiers a session has already seen. */
export interface SeenIdentifiers {
  /** The deployment ids. */
  deployments: string[];
  /** The CI run ids. */
  runs: string[];
  /** The issue numbers. */
  issues: number[];
}

/**
 * The identifiers that appear in a conversation.
 *
 * They are read from the tool arguments and from the text of the tool
 * results, because a result mentions the ids it is about.
 */
export function extractIdentifiers(
  messages: ProviderMessage[],
): SeenIdentifiers {
  const deployments = new Set<string>();
  const runs = new Set<string>();
  const issues = new Set<number>();

  const consider = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\bdep_[A-Za-z0-9_-]+/g)) {
        deployments.add(match[0]);
      }
      for (const match of value.matchAll(/\brun_[A-Za-z0-9_-]+/g)) {
        runs.add(match[0]);
      }
      for (const match of value.matchAll(/\bissue #(\d+)\b/gi)) {
        issues.add(Number(match[1]));
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) consider(item);
      return;
    }

    if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'deploymentId' && typeof item === 'string') {
          deployments.add(item);
          continue;
        }
        if (key === 'runId' && typeof item === 'string') {
          runs.add(item);
          continue;
        }
        if (key === 'issueNumber' && typeof item === 'number') {
          issues.add(item);
          continue;
        }
        consider(item);
      }
    }
  };

  for (const message of messages) {
    consider(message.content);
    for (const call of message.toolCalls ?? []) {
      try {
        consider(JSON.parse(call.arguments || '{}'));
      } catch {
        // A tool call whose arguments are not JSON still has a name.
        consider(call.name);
      }
    }
  }

  return {
    deployments: [...deployments].sort(),
    runs: [...runs].sort(),
    issues: [...issues].sort((a, b) => a - b),
  };
}

/**
 * The message list after compaction.
 *
 * The system prompt stays first. The summary goes straight after it, and
 * the kept messages follow **in their original order** — nothing is
 * reordered, so the provider's cached prefix still lines up.
 */
export function compactMessages(
  messages: ProviderMessage[],
  options: CompactionOptions,
): ProviderMessage[] {
  const keepTurns = options.keepTurns ?? DEFAULT_KEEP_TURNS;

  const system = messages.filter((message) => message.role === 'system');
  const rest = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.role !== 'system');

  // The last `keepTurns` user messages mark where the verbatim part
  // starts. Everything from there on is kept.
  const userIndexes = rest
    .filter((entry) => entry.message.role === 'user')
    .map((entry) => entry.index);
  const boundary =
    userIndexes.length > keepTurns ? userIndexes[userIndexes.length - keepTurns]! : 0;

  // Every tool call and its result is kept, wherever it is.
  const kept = rest.filter(
    (entry) =>
      entry.index >= boundary ||
      entry.message.role === 'tool' ||
      (entry.message.role === 'assistant' && (entry.message.toolCalls?.length ?? 0) > 0),
  );

  const identifiers = extractIdentifiers(messages);

  return [
    ...system,
    { role: 'user' as const, content: summaryBlock(options.summary, identifiers) },
    ...kept.map((entry) => entry.message),
  ];
}

/**
 * The block that carries the summary and the identifiers.
 *
 * The identifiers are repeated here so they survive even if the tool
 * results they came from were summarised away.
 */
export function summaryBlock(
  summary: string,
  identifiers: SeenIdentifiers,
): string {
  const lines: string[] = [];

  lines.push('Summary of the conversation so far:');
  lines.push('');
  lines.push(summary.trim());
  lines.push('');

  const found: string[] = [];
  for (const id of identifiers.deployments) found.push(`- deployment ${id}`);
  for (const id of identifiers.runs) found.push(`- CI run ${id}`);
  for (const number of identifiers.issues) found.push(`- issue #${number}`);

  if (found.length > 0) {
    lines.push('Identifiers already seen — do not lose them:');
    lines.push(...found);
    lines.push('');
  }

  lines.push(
    'The conversation above was compacted. Everything before this point has ' +
      'been summarised; the tool calls and the most recent turns are verbatim.',
  );

  return lines.join('\n');
}

/**
 * Asks the model for the summary.
 *
 * The model is given the conversation and the compaction prompt, and it
 * answers with a summary and nothing else.
 */
export async function summarise(
  provider: AIProvider,
  messages: ProviderMessage[],
  options: { previousSummary?: string | null } = {},
): Promise<string | null> {
  const prompt = await loadCompactionPrompt();

  const conversation = messages
    .filter((message) => message.role !== 'system')
    .map((message) => {
      if (message.role === 'tool') {
        return `[tool ${message.name ?? 'tool'}] ${message.content ?? ''}`;
      }
      if (message.toolCalls?.length) {
        const calls = message.toolCalls
          .map((call) => `${call.name}(${call.arguments})`)
          .join(', ');
        return `[assistant] ${message.content ?? ''} ${calls}`.trim();
      }
      return `[${message.role}] ${message.content ?? ''}`;
    })
    .join('\n\n');

  const previous = options.previousSummary
    ? `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`
    : '';

  try {
    const response = await provider.chat({
      messages: [
        {
          role: 'user',
          content: `${previous}${prompt}\n\nThe conversation to summarise:\n\n${conversation}`,
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

/** The compaction prompt, read from the file next to this module. */
let cachedPrompt: string | null = null;

async function loadCompactionPrompt(): Promise<string> {
  if (cachedPrompt !== null) return cachedPrompt;

  try {
    const { readFile } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = dirname(fileURLToPath(import.meta.url));
    cachedPrompt = await readFile(join(here, 'prompts', 'compaction.txt'), 'utf8');
  } catch {
    cachedPrompt =
      'You are a context summarization assistant for operations triage. ' +
      'Summarise the conversation: the deployments, the CI runs, the issues, ' +
      'the decisions that were taken, and what the user asked for. Keep every ' +
      'identifier exactly as it was written.';
  }

  return cachedPrompt;
}
