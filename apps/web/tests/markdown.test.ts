import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { renderMarkdown } from '../lib/markdown.js';

/**
 * The model writes markdown tables. Groq's answers do it routinely, and
 * without this they rendered as raw pipes - which looks broken in the one
 * place the user is reading the answer.
 */
function html(markdown: string): string {
  return renderToStaticMarkup(renderMarkdown(markdown));
}

describe('markdown tables', () => {
  it('renders a table with a header row', () => {
    const markup = html(
      '| Deployment | Commit | Status |\n|---|---:|---|\n| `dep_1` | `a1c93f2` | failed |',
    );

    expect(markup).toContain('<table');
    expect(markup).toContain('<th');
    expect(markup).toContain('Deployment');
    expect(markup).toContain('</table>');
    // `<th` also matches `<thead`, so count the cells only.
    expect(markup.match(/<th[\s>]/g)?.length).toBe(3);
  });

  it('renders the body rows', () => {
    const markup = html('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(markup).toContain('<td');
    expect(markup).toContain('1');
    expect(markup).toContain('2');
  });

  it('keeps the inline markdown inside the cells', () => {
    const markup = html('| name | note |\n|---|---|\n| `dep_1` | **failed** |');
    expect(markup).toContain('<code');
    expect(markup).toContain('<strong');
  });

  it('accepts a table without the outer pipes', () => {
    const markup = html('a | b\n---|---\n1 | 2');
    expect(markup).toContain('<table');
    expect(markup).toContain('1');
  });

  it('leaves a paragraph with a pipe in it alone', () => {
    const markup = html('Run this: a | b');
    expect(markup).not.toContain('<table');
  });

  it('leaves a bulleted list alone', () => {
    const markup = html('- one\n- two');
    expect(markup).toContain('<ul');
    expect(markup).not.toContain('<table');
  });
});
