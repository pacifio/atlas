// A composer's keys. History (⌘Z / ⇧⌘Z / ⌘Y) is StarterKit's undo/redo,
// configured in `composer-editor.tsx`.
//
//   Enter          send when `enterToSend`, else a newline that continues a
//                  list (`- `, `* `, `1. `, `- [ ] `) or a quote (`> `).
//   Shift+Enter    a plain newline.
//   ⌘/Ctrl+Enter   send, always.
//   Backspace      right after a list or quote marker, removes the marker.
//   Tab / ⇧Tab     indent / outdent a list line by two spaces; elsewhere the
//                  browser's own Tab, so focus can still leave the field.
//   ⌘] / ⌘[        indent / outdent the selected lines, any line.
//   ⌥↑ / ⌥↓        move the selected lines up / down.
//   ⇧⌥↑ / ⇧⌥↓      copy the selected lines, the selection on the top / bottom
//                  copy.
//   ⇧⌘K            delete the selected lines.
//   ← / →          step over a chip in one press instead of selecting it.
//   Escape         the feature's `onEscape`, if it gives one.
//
// These are the CodeMirror composer's keys: its default keymap and its
// markdown keymap. An Enter on an empty list item ends the list instead of
// starting another one (outdenting first when the item is nested); an Enter
// inside an open code fence is a plain newline; adding or removing a numbered
// item renumbers the items after it. Multiple cursors (⌘⌥↑ / ⌘⌥↓) are not
// carried over: ProseMirror has one selection.
//
// Lines are paragraphs (`composer-doc.ts`), so every rule here reads and
// writes paragraphs' text.
//
// Priority sits below `ComposerTriggers`, so an open picker gets Enter, Tab,
// the arrows and Escape first.

import { Extension, type Editor } from "@tiptap/core";
import { splitBlock } from "@tiptap/pm/commands";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

import { FenceTracker } from "./composer-doc";

export interface ComposerKeymapOptions {
  /** Read live, so the setting applies without rebuilding the editor. */
  getEnterToSend: () => boolean;
  onSubmit: () => void;
  /** Return true when Escape did something. */
  onEscape: (() => boolean) | null;
}

const LEAF_CHAR = "￼";
const LIST = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/;
const ORDERED = /^(\s*)(\d+)([.)])\s/;
const QUOTE = /^(\s*>\s?)/;
const INDENT = "  ";

function lineText(node: PMNode): string {
  return node.textBetween(0, node.content.size, undefined, LEAF_CHAR);
}

function currentLine(state: EditorState): { text: string; start: number; offset: number } | null {
  const { $from } = state.selection;
  if (!$from.parent.isTextblock) return null;
  return { text: lineText($from.parent), start: $from.start(), offset: $from.parentOffset };
}

/** Whether the lines above line `index` leave a code fence open. */
function inOpenFence(doc: PMNode, index: number): boolean {
  const fences = new FenceTracker();
  for (let i = 0; i < index; i++) fences.line(lineText(doc.child(i)));
  return fences.open;
}

/** The position where line `index` starts (before its paragraph). */
function lineStart(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

/**
 * Renumber the numbered items after line `index` that belong to the same list
 * (same indent; deeper lines are nested and skipped), counting on from the
 * nearest numbered item at or above `index`. Stops at the first line that is
 * neither. Writes into `tr`.
 */
export function renumberAfter(tr: Transaction, index: number, indent: string): void {
  const doc = tr.doc;
  let n: number | null = null;
  for (let i = index; i >= 0; i--) {
    const m = ORDERED.exec(lineText(doc.child(i)));
    if (m && m[1] === indent) {
      n = Number(m[2]);
      break;
    }
    if (i === index) continue;
    const lead = /^\s*/.exec(lineText(doc.child(i)))![0];
    if (lead.length <= indent.length) break;
  }
  // With nothing above to count from, the first item after keeps its number.
  let pos = lineStart(tr.doc, index + 1);
  for (let i = index + 1; i < tr.doc.childCount; i++) {
    const node = tr.doc.child(i);
    const text = lineText(node);
    const m = ORDERED.exec(text);
    if (m && m[1] === indent) {
      const want: number = n === null ? Number(m[2]) : n + 1;
      n = want;
      if (m[2] !== String(want)) {
        const from = pos + 1 + indent.length;
        tr.insertText(String(want), from, from + m[2].length);
      }
    } else {
      const lead = /^\s*/.exec(text)![0];
      if (text.trim() === "" || lead.length <= indent.length) break;
    }
    pos += tr.doc.child(i).nodeSize;
  }
}

/** Newline that carries a list or quote marker onto the next line. Returns
 *  false (and does nothing) when the caret is not on such a line, or is
 *  inside an open code fence. */
export function continueMarkup(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  if (!state.selection.empty) return false;
  const line = currentLine(state);
  if (!line) return false;
  let prefix: string;
  let next: string;
  let indent = "";
  let ordered = false;
  const list = LIST.exec(line.text);
  const quote = list ? null : QUOTE.exec(line.text);
  if (list) {
    const [whole, lead, bullet, num, delim, space, task] = list;
    prefix = whole;
    indent = lead;
    ordered = num !== undefined;
    next = `${lead}${bullet ?? `${Number(num) + 1}${delim}`}${space}${task ? "[ ] " : ""}`;
  } else if (quote) {
    prefix = quote[1];
    next = quote[1];
  } else {
    return false;
  }
  // Caret inside the marker itself: a plain newline is what the user means.
  if (line.offset < prefix.length) return false;
  const index = state.selection.$from.index(0);
  if (inOpenFence(state.doc, index)) return false;
  const tr = state.tr;
  if (line.text.slice(prefix.length).trim() === "") {
    // Empty item: outdent a nested one, end a top-level one.
    if (indent.length >= INDENT.length) {
      tr.delete(line.start, line.start + INDENT.length);
    } else {
      tr.delete(line.start, line.start + line.text.length);
    }
    dispatch(tr.scrollIntoView());
    return true;
  }
  tr.split(state.selection.from).insertText(next);
  if (ordered) renumberAfter(tr, index + 1, indent);
  dispatch(tr.scrollIntoView());
  return true;
}

/** Backspace with the caret right after a list or quote marker: the marker
 *  goes, the indent stays, and a numbered list renumbers. */
function deleteMarkup(state: EditorState, dispatch: (tr: Transaction) => void): boolean {
  if (!state.selection.empty) return false;
  const line = currentLine(state);
  if (!line) return false;
  const list = LIST.exec(line.text);
  const quote = list ? null : QUOTE.exec(line.text);
  const prefix = list?.[0] ?? quote?.[1];
  if (!prefix || line.offset !== prefix.length) return false;
  const index = state.selection.$from.index(0);
  if (inOpenFence(state.doc, index)) return false;
  const lead = list ? list[1] : "";
  const tr = state.tr.delete(line.start + lead.length, line.start + prefix.length);
  if (list?.[3] !== undefined) renumberAfter(tr, index, lead);
  dispatch(tr.scrollIntoView());
  return true;
}

function isListLine(state: EditorState): boolean {
  const line = currentLine(state);
  return !!line && LIST.test(line.text);
}

/** The selection's lines: first and last paragraph index. */
function selectedLines(state: EditorState): { first: number; last: number } {
  const { $from, $to } = state.selection;
  return { first: $from.index(0), last: $to.index(0) };
}

/** Indent (or outdent) every selected line by two spaces. */
function indentLines(state: EditorState, dispatch: (tr: Transaction) => void, out: boolean) {
  const { first, last } = selectedLines(state);
  const tr = state.tr;
  for (let i = last; i >= first; i--) {
    const start = lineStart(state.doc, i) + 1;
    if (out) {
      const lead = /^ {1,2}/.exec(lineText(state.doc.child(i)))?.[0].length ?? 0;
      if (lead > 0) tr.delete(start, start + lead);
    } else {
      tr.insertText(INDENT, start);
    }
  }
  if (tr.docChanged) dispatch(tr.scrollIntoView());
  return true;
}

function indentListLine(editor: Editor, out: boolean): boolean {
  const { state, view } = editor;
  if (!isListLine(state)) return false;
  indentLines(state, (tr) => view.dispatch(tr), out);
  // Swallowed either way on a list line: Tab must not move focus out of the
  // field halfway through a list.
  return true;
}

/** Move the selected lines one line up or down, the selection with them. */
function moveLines(state: EditorState, dispatch: (tr: Transaction) => void, up: boolean) {
  const { first, last } = selectedLines(state);
  const doc = state.doc;
  // At the edge: nothing to swap with, but the key is still this composer's.
  if (up ? first === 0 : last === doc.childCount - 1) return true;
  const other = up ? first - 1 : last + 1;
  const block: PMNode[] = [];
  for (let i = first; i <= last; i++) block.push(doc.child(i));
  const from = lineStart(doc, Math.min(first, other));
  const to = lineStart(doc, Math.max(last, other) + 1);
  const nodes = up ? [...block, doc.child(other)] : [doc.child(other), ...block];
  const shift = up ? -doc.child(other).nodeSize : doc.child(other).nodeSize;
  const tr = state.tr.replaceWith(from, to, nodes);
  const { anchor, head } = state.selection;
  tr.setSelection(TextSelection.create(tr.doc, anchor + shift, head + shift));
  dispatch(tr.scrollIntoView());
  return true;
}

/** Copy the selected lines below themselves; the selection stays on the top
 *  copy (`up`) or moves to the bottom one. */
function copyLines(state: EditorState, dispatch: (tr: Transaction) => void, up: boolean) {
  const { first, last } = selectedLines(state);
  const doc = state.doc;
  const block: PMNode[] = [];
  let size = 0;
  for (let i = first; i <= last; i++) {
    block.push(doc.child(i));
    size += doc.child(i).nodeSize;
  }
  const tr = state.tr.insert(lineStart(doc, last + 1), block);
  if (!up) {
    const { anchor, head } = state.selection;
    tr.setSelection(TextSelection.create(tr.doc, anchor + size, head + size));
  }
  dispatch(tr.scrollIntoView());
  return true;
}

/** Delete the selected lines; the caret keeps its column on the next line. */
function deleteLines(state: EditorState, dispatch: (tr: Transaction) => void) {
  const { first, last } = selectedLines(state);
  const doc = state.doc;
  const column = state.selection.$head.parentOffset;
  const tr = state.tr;
  if (first === 0 && last === doc.childCount - 1) {
    tr.replaceWith(0, doc.content.size, doc.type.schema.nodes.paragraph.create());
  } else {
    tr.delete(lineStart(doc, first), lineStart(doc, last + 1));
  }
  const at = Math.min(first, tr.doc.childCount - 1);
  const line = tr.doc.child(at);
  const pos = lineStart(tr.doc, at) + 1 + Math.min(column, line.content.size);
  tr.setSelection(TextSelection.create(tr.doc, pos));
  dispatch(tr.scrollIntoView());
  return true;
}

/** ← / → beside a chip: one press puts the caret on its other side. */
function stepOverChip(state: EditorState, dispatch: (tr: Transaction) => void, dir: -1 | 1) {
  const { selection } = state;
  if (!selection.empty) return false;
  const $pos = selection.$head;
  const node = dir > 0 ? $pos.nodeAfter : $pos.nodeBefore;
  if (!node || node.isText || !node.isAtom || !node.isInline) return false;
  const pos = $pos.pos + dir * node.nodeSize;
  dispatch(state.tr.setSelection(TextSelection.create(state.doc, pos)).scrollIntoView());
  return true;
}

function newline(editor: Editor, continueLists: boolean): boolean {
  const { state, view } = editor;
  const dispatch = (tr: Transaction) => view.dispatch(tr.scrollIntoView());
  if (continueLists && continueMarkup(state, dispatch)) return true;
  return splitBlock(state, dispatch);
}

export const ComposerKeymap = Extension.create<ComposerKeymapOptions>({
  name: "atlasComposerKeymap",
  priority: 900,

  addOptions() {
    return { getEnterToSend: () => true, onSubmit: () => {}, onEscape: null };
  },

  addKeyboardShortcuts() {
    const guard = (run: () => boolean) => () => (this.editor.view.composing ? false : run());
    // A command over the current state, dispatching into the view.
    const command =
      (run: (state: EditorState, dispatch: (tr: Transaction) => void) => boolean) => () =>
        this.editor.view.composing
          ? false
          : run(this.editor.state, (tr) => this.editor.view.dispatch(tr));
    return {
      Enter: guard(() => {
        if (this.options.getEnterToSend()) {
          this.options.onSubmit();
          return true;
        }
        return newline(this.editor, true);
      }),
      "Shift-Enter": guard(() => newline(this.editor, false)),
      "Mod-Enter": guard(() => {
        this.options.onSubmit();
        return true;
      }),
      Backspace: command(deleteMarkup),
      Tab: guard(() => indentListLine(this.editor, false)),
      "Shift-Tab": guard(() => indentListLine(this.editor, true)),
      "Mod-]": command((s, d) => indentLines(s, d, false)),
      "Mod-[": command((s, d) => indentLines(s, d, true)),
      "Alt-ArrowUp": command((s, d) => moveLines(s, d, true)),
      "Alt-ArrowDown": command((s, d) => moveLines(s, d, false)),
      "Shift-Alt-ArrowUp": command((s, d) => copyLines(s, d, true)),
      "Shift-Alt-ArrowDown": command((s, d) => copyLines(s, d, false)),
      "Shift-Mod-k": command(deleteLines),
      ArrowLeft: command((s, d) => stepOverChip(s, d, -1)),
      ArrowRight: command((s, d) => stepOverChip(s, d, 1)),
      Escape: guard(() => this.options.onEscape?.() ?? false),
    };
  },
});
