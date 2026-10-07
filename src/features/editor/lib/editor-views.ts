/**
 * The live CodeMirror views, by tab id, so a caller outside the editor panel
 * can read where the cursor is *on demand*.
 *
 * This is deliberately a lookup and not a mirror: CodeMirror owns the
 * document and the selection (docs/architecture.md, the authoritative-state
 * boundary), and copying the cursor into a store on every keystroke is the
 * cost that boundary exists to avoid.
 */

import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

const views = new Map<string, EditorView>();

/** Record `view` as the one editing `tabId`; returns the matching unregister.
 *  An unregister only removes the view it registered, so a stale cleanup
 *  cannot drop the view a remounted panel put there since. */
export function registerEditorView(tabId: string, view: EditorView): () => void {
  views.set(tabId, view);
  return () => {
    if (views.get(tabId) === view) views.delete(tabId);
  };
}

export function getEditorView(tabId: string): EditorView | undefined {
  return views.get(tabId);
}

export interface LineCol {
  line: number;
  col: number;
}

export interface EditorPosition {
  cursor: LineCol;
  /** Present only when something is selected. */
  selection?: { from: LineCol; to: LineCol };
}

/** Where the cursor is in `state`, 1-based, plus the selection if any. */
export function editorPosition(state: EditorState): EditorPosition {
  const at = (pos: number): LineCol => {
    const line = state.doc.lineAt(pos);
    return { line: line.number, col: pos - line.from + 1 };
  };
  const { main } = state.selection;
  if (main.empty) return { cursor: at(main.head) };
  return { cursor: at(main.head), selection: { from: at(main.from), to: at(main.to) } };
}
