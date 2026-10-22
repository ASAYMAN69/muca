/**
 * A small, deterministic unified-diff generator.
 *
 * The mock world needs a **real** diff: the pull request's diff has to
 * change when the branch changes, or `push_commit` would be a tool that
 * returns a commit and changes nothing.
 *
 * The implementation is the classic longest-common-subsequence line diff
 * with three lines of context. It is not the fastest, and it does not
 * have to be: the files are a handful of lines long.
 */

/** One line of the diff. */
interface DiffOp {
  type: 'equal' | 'delete' | 'insert';
  line: string;
}

/** The longest common subsequence of two line arrays, as diff operations. */
function diffLines(before: string[], after: string[]): DiffOp[] {
  const n = before.length;
  const m = after.length;

  // `lcs[i][j]` is the length of the longest common subsequence of
  // `before[i…]` and `after[j…]`.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (before[i] === after[j]) {
      ops.push({ type: 'equal', line: before[i]! });
      i += 1;
      j += 1;
      continue;
    }
    if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ type: 'delete', line: before[i]! });
      i += 1;
    } else {
      ops.push({ type: 'insert', line: after[j]! });
      j += 1;
    }
  }

  while (i < n) {
    ops.push({ type: 'delete', line: before[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'insert', line: after[j]! });
    j += 1;
  }

  return ops;
}

/** How many unchanged lines are shown around a change. */
const CONTEXT = 3;

/**
 * The unified diff between two versions of one file.
 *
 * It is empty when the two versions are the same.
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) return '';

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const ops = diffLines(beforeLines, afterLines);

  // The line numbers of the "before" and "after" versions, as the walk
  // goes.
  let beforeLine = 1;
  let afterLine = 1;
  const numbered = ops.map((op) => {
    const entry = {
      ...op,
      beforeLine: op.type === 'insert' ? 0 : beforeLine,
      afterLine: op.type === 'delete' ? 0 : afterLine,
    };
    if (op.type !== 'insert') beforeLine += 1;
    if (op.type !== 'delete') afterLine += 1;
    return entry;
  });

  // The hunks: a run of changes, with the context around it.
  const hunks: string[] = [];
  let index = 0;

  while (index < numbered.length) {
    if (numbered[index]!.type === 'equal') {
      index += 1;
      continue;
    }

    // The start of the hunk, with the context before it.
    const start = Math.max(0, index - CONTEXT);
    let end = index;
    while (end < numbered.length) {
      if (numbered[end]!.type !== 'equal') {
        end += 1;
        continue;
      }
      // A run of unchanged lines: keep it only when it is short, or
      // when it is the last one.
      let run = 0;
      while (end + run < numbered.length && numbered[end + run]!.type === 'equal') {
        run += 1;
      }
      if (run > CONTEXT * 2 && end + run < numbered.length) break;
      end += run;
    }
    const stop = Math.min(numbered.length, end + CONTEXT);

    const body = numbered.slice(start, stop);
    const beforeCount = body.filter((op) => op.type !== 'insert').length;
    const afterCount = body.filter((op) => op.type !== 'delete').length;
    const firstBefore = body.find((op) => op.type !== 'insert')?.beforeLine ?? 0;
    const firstAfter = body.find((op) => op.type !== 'delete')?.afterLine ?? 0;

    const lines = body.map((op) => {
      if (op.type === 'equal') return ` ${op.line}`;
      if (op.type === 'delete') return `-${op.line}`;
      return `+${op.line}`;
    });

    hunks.push(
      `@@ -${firstBefore},${beforeCount} +${firstAfter},${afterCount} @@`,
      ...lines,
    );

    index = stop;
  }

  if (hunks.length === 0) return '';

  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
  ].join('\n');
}

/**
 * The unified diff of several files.
 *
 * The files are sorted, so the diff is the same every time.
 */
export function unifiedDiffOfFiles(
  files: Array<{ path: string; before: string; after: string }>,
): string {
  const parts = files
    .filter((file) => file.before !== file.after)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => unifiedDiff(file.path, file.before, file.after))
    .filter((diff) => diff.length > 0);

  return parts.join('\n');
}
