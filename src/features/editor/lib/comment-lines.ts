import { RangeSetBuilder, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/**
 * Lines with an open comment in a Shared Thread file (ATL-416), marked in the
 * editor. Dispatch `setCommentLines` with where each discussion is now; the
 * marks ride their text through edits until the next placement.
 */

/** Lines, 1-based and inclusive. */
export interface CommentSpan {
  start: number;
  end: number;
}

export const setCommentLines = StateEffect.define<CommentSpan[]>();

const marked = Decoration.line({ class: "atlas-thread-comment-line" });

function build(state: EditorState, spans: CommentSpan[]): DecorationSet {
  const lines = new Set<number>();
  for (const s of spans) {
    for (let n = Math.max(1, s.start); n <= Math.min(s.end, state.doc.lines); n++) lines.add(n);
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const n of [...lines].sort((a, b) => a - b)) {
    const line = state.doc.line(n);
    builder.add(line.from, line.from, marked);
  }
  return builder.finish();
}

export const commentLinesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const e of tr.effects) if (e.is(setCommentLines)) next = build(tr.state, e.value);
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const commentLinesTheme = EditorView.baseTheme({
  ".atlas-thread-comment-line": {
    backgroundColor: "color-mix(in srgb, var(--atlas-status-warning-foreground) 9%, transparent)",
  },
});

export const commentLines = [commentLinesField, commentLinesTheme];

/** The lines the main selection covers, 1-based; `null` for a bare caret. */
export function selectedLines(state: EditorState): CommentSpan | null {
  const sel = state.selection.main;
  if (sel.empty) return null;
  const start = state.doc.lineAt(sel.from).number;
  // A selection ending at a line's very start does not take that line.
  const endLine = state.doc.lineAt(sel.to);
  const end = sel.to === endLine.from && endLine.number > start ? endLine.number - 1 : endLine.number;
  return { start, end };
}
