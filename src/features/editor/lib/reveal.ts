/**
 * Moving a file view to a line, column or range — the "open at line" half of
 * opening a file.
 *
 * Every coordinate is 1-based, as people and agents count them. The editor
 * counts from zero and clamps out-of-range positions itself (a line past the
 * end lands on the last line), which matters because the caller is often
 * reading numbers off stale output.
 */

/** Where to put the cursor, or what to select. 1-based. */
export interface RevealTarget {
  line: number;
  column?: number;
  /** When set, select from (line, column) to (endLine, endColumn). */
  endLine?: number;
  /** Defaults to the end of `endLine`. */
  endColumn?: number;
}

const zero = (n: number | undefined, fallback: number) =>
  n === undefined ? fallback : Math.max(0, Math.floor(n) - 1);

/** `target` as the editor's zero-based selection, caret at its end. */
export function revealSelection(target: RevealTarget): {
  start: { line: number; character: number };
  end: { line: number; character: number };
  direction: "none" | "forward";
} {
  const start = { line: zero(target.line, 0), character: zero(target.column, 0) };
  if (target.endLine === undefined) return { start, end: start, direction: "none" };
  const end = {
    line: zero(target.endLine, start.line),
    // Past the line's end: the editor clamps it to the end.
    character: zero(target.endColumn, Number.MAX_SAFE_INTEGER),
  };
  return { start, end, direction: "forward" };
}
