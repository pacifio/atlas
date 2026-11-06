/**
 * Moving an editor to a line, column or range — the "open at line" half of
 * opening a file. Pure except for {@link applyReveal}, which is the one place
 * a reveal touches a live `EditorView`.
 *
 * Every coordinate is 1-based, as people and agents count them, and every one
 * is clamped: a line past the end lands on the last line rather than throwing
 * inside CodeMirror, because the caller is often reading numbers off stale
 * output.
 */

import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Where to put the cursor, or what to select. 1-based. */
export interface RevealTarget {
  line: number;
  column?: number;
  /** When set, select from (line, column) to (endLine, endColumn). */
  endLine?: number;
  /** Defaults to the end of `endLine`. */
  endColumn?: number;
}

/** The document offsets `target` resolves to in `doc`. */
export function revealRange(doc: Text, target: RevealTarget): { anchor: number; head: number } {
  const lineAt = (n: number) => doc.line(Math.min(Math.max(1, Math.floor(n)), doc.lines));
  const offsetIn = (line: ReturnType<Text["line"]>, column: number) =>
    line.from + Math.min(Math.max(0, Math.floor(column) - 1), line.length);

  const start = lineAt(target.line);
  const anchor = offsetIn(start, target.column ?? 1);
  if (target.endLine === undefined) return { anchor, head: anchor };

  const end = lineAt(target.endLine);
  const head = target.endColumn === undefined ? end.to : offsetIn(end, target.endColumn);
  return { anchor, head };
}

/** Select `target` in `view`, scroll it to the middle, and focus the editor. */
export function applyReveal(view: EditorView, target: RevealTarget): void {
  const { anchor, head } = revealRange(view.state.doc, target);
  view.dispatch({
    selection: { anchor, head },
    effects: EditorView.scrollIntoView(anchor, { y: "center" }),
  });
  view.focus();
}
