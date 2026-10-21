/**
 * A very small markdown renderer.
 *
 * The agent's final answer is prose with a little structure in it:
 * `**bold**`, `` `code` ``, `- ` bullets and blank-line paragraphs.
 * That is the whole vocabulary we support, and it is enough to make the
 * outcome read like an answer rather than a wall of asterisks.
 *
 * Everything is rendered as React elements, so nothing is injected as
 * raw HTML.
 */

import { Fragment, type ReactNode } from 'react';

/** Renders inline markdown: `**bold**` and `` `code` ``. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(
        <strong
          key={`${keyPrefix}-b${index}`}
          className="font-semibold text-neutral-900 dark:text-neutral-100"
        >
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <code
          key={`${keyPrefix}-c${index}`}
          className="rounded bg-neutral-100 px-1 py-px font-mono text-[0.9em] text-neutral-800 dark:bg-neutral-800 dark:text-neutral-300"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = match.index + token.length;
    index += 1;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

/** Renders a block of markdown into paragraphs and lists. */
export function renderMarkdown(source: string): ReactNode {
  const blocks = source.split(/\n{2,}/);
  const out: ReactNode[] = [];

  blocks.forEach((block, blockIndex) => {
    const trimmed = block.trim();
    if (!trimmed) return;

    const lines = trimmed.split('\n');
    const isList = lines.every((line) => line.trimStart().startsWith('- '));

    if (isList) {
      out.push(
        <ul
          key={`ul-${blockIndex}`}
          className="ml-4 list-disc space-y-1 marker:text-neutral-400 dark:marker:text-neutral-600"
        >
          {lines.map((line, lineIndex) => (
            <li key={`li-${blockIndex}-${lineIndex}`}>
              {renderInline(line.trimStart().slice(2), `l${blockIndex}-${lineIndex}`)}
            </li>
          ))}
        </ul>,
      );
      return;
    }

    out.push(
      <p key={`p-${blockIndex}`}>
        {lines.map((line, lineIndex) => (
          <Fragment key={`ln-${blockIndex}-${lineIndex}`}>
            {lineIndex > 0 ? <br /> : null}
            {renderInline(line, `p${blockIndex}-${lineIndex}`)}
          </Fragment>
        ))}
      </p>,
    );
  });

  return out;
}
