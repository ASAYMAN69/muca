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

/**
 * Splits a table row into its cells.
 *
 * A leading and trailing pipe are optional, so `a | b` and `| a | b |`
 * are the same row.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

/** True when a row is the `|---|---|` separator under a header. */
function isSeparatorRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/**
 * True when a block is a table: every line has a pipe, and the second
 * line is the separator.
 */
function isTable(lines: string[]): boolean {
  if (lines.length < 2) return false;
  if (!lines.every((line) => line.includes('|'))) return false;
  return isSeparatorRow(lines[1]);
}

/** Renders a markdown table. */
function renderTable(lines: string[], keyPrefix: string): ReactNode {
  const header = splitRow(lines[0]!);
  const rows = lines.slice(2).map(splitRow);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line">
            {header.map((cell, index) => (
              <th
                key={`th-${keyPrefix}-${index}`}
                className="whitespace-nowrap px-2.5 py-1.5 font-semibold text-ink"
              >
                {renderInline(cell, `th-${keyPrefix}-${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr
              key={`tr-${keyPrefix}-${rowIndex}`}
              className="border-b border-line/60 last:border-0"
            >
              {row.map((cell, cellIndex) => (
                <td
                  key={`td-${keyPrefix}-${rowIndex}-${cellIndex}`}
                  className="px-2.5 py-1.5 align-top text-ink-muted"
                >
                  {renderInline(cell, `td-${keyPrefix}-${rowIndex}-${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

    if (isTable(lines)) {
      out.push(
        <div key={`table-${blockIndex}`} className="my-1">
          {renderTable(lines, `t${blockIndex}`)}
        </div>,
      );
      return;
    }

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
