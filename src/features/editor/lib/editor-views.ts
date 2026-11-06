/**
 * Where the cursor is in each open file tab, read on demand by tab id, so a
 * caller outside the file view (the palette's "Open in editor", the agent's
 * UI state) can ask without the view mirroring its cursor anywhere.
 *
 * This is deliberately a lookup and not a mirror: the view's editor owns the
 * document and the selection (docs/architecture.md, the authoritative-state
 * boundary), and copying the cursor into a store on every keystroke is the
 * cost that boundary exists to avoid.
 */

export interface LineCol {
  line: number;
  col: number;
}

export interface EditorPosition {
  cursor: LineCol;
  /** Present only when something is selected. */
  selection?: { from: LineCol; to: LineCol };
}

type PositionReader = () => EditorPosition | undefined;

const readers = new Map<string, PositionReader>();

/** Record `read` as the cursor of `tabId`; returns the matching unregister.
 *  An unregister only removes the reader it registered, so a stale cleanup
 *  cannot drop the one a remounted view put there since. */
export function registerEditorView(tabId: string, read: PositionReader): () => void {
  readers.set(tabId, read);
  return () => {
    if (readers.get(tabId) === read) readers.delete(tabId);
  };
}

/** The cursor of `tabId`'s file view, 1-based; undefined when it has none. */
export function getEditorPosition(tabId: string): EditorPosition | undefined {
  return readers.get(tabId)?.();
}

/** A zero-based selection, as the view's editor holds it. */
export interface ZeroBasedSelection {
  start: { line: number; character: number };
  end: { line: number; character: number };
  /** -1: the caret is at `start`. */
  direction: -1 | 0 | 1;
}

/** The 1-based position of an editor's primary selection. */
export function positionOfSelection(selection: ZeroBasedSelection): EditorPosition {
  const at = (p: { line: number; character: number }): LineCol => ({
    line: p.line + 1,
    col: p.character + 1,
  });
  const caret = selection.direction === -1 ? selection.start : selection.end;
  const empty =
    selection.start.line === selection.end.line &&
    selection.start.character === selection.end.character;
  if (empty) return { cursor: at(caret) };
  return { cursor: at(caret), selection: { from: at(selection.start), to: at(selection.end) } };
}
