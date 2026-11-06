// The composer's document model, and the one place prompt text and the
// editor's document convert into each other.
//
// Model
//   - The doc is `paragraph+`. One paragraph is one line of text, so a newline
//     is a paragraph split and an empty line is an empty paragraph. No marks
//     and no other blocks: a composer edits plain text (markdown is the
//     reader's business), which is what keeps the conversion exact both ways.
//   - A chip is an inline atom node (`composer-chip.tsx`). Each feature decides
//     what text a chip stands for — the session composer writes a mention's
//     short form, team chat a `<@user_id>` — through a `ComposerSerializer`.
//
// The reverse trip (`textToDoc`) is for a draft restored on remount, a prefill
// and a plain-text paste. A feature's `tokenize` turns lines into text runs
// and chips — all the lines at once, because whether a token is a chip can
// depend on the lines around it (team chat leaves a mention inside a code
// fence as text). The rule every tokenizer keeps is that a chip only replaces
// text it writes back byte for byte, so text → doc → text is the identity.
// Each feature's round-trip test holds it to that.
//
// Nothing here touches the DOM or React.

import type { JSONContent } from "@tiptap/core";
import type { Fragment, Node as PMNode } from "@tiptap/pm/model";

/** How a feature's text and the composer's document map onto each other. */
export interface ComposerSerializer {
  /** Lines of text → each line's inline content (text runs and chips). */
  tokenize(lines: readonly string[]): JSONContent[][];
  /** A chip node → the text it stands for. */
  chipText(node: PMNode): string;
}

/** Text → the composer's paragraphs. */
export function textToParagraphs(text: string, serializer: ComposerSerializer): JSONContent[] {
  return serializer
    .tokenize(text.split("\n"))
    .map((content) =>
      content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" },
    );
}

/** Text → a whole composer document. */
export function textToDoc(text: string, serializer: ComposerSerializer): JSONContent {
  return { type: "doc", content: textToParagraphs(text, serializer) };
}

function inlineText(node: PMNode, serializer: ComposerSerializer): string {
  if (node.isText) return node.text ?? "";
  if (node.type.name === "hardBreak") return "\n";
  return serializer.chipText(node);
}

/** Blocks (or, for a slice cut inside one line, inline nodes) → text. Shared
 *  by the send path and the clipboard. */
export function fragmentToText(fragment: Fragment, serializer: ComposerSerializer): string {
  const lines: string[] = [];
  let open: string[] | null = null;
  fragment.forEach((node) => {
    if (node.isBlock) {
      const parts: string[] = [];
      node.forEach((child) => parts.push(inlineText(child, serializer)));
      lines.push(parts.join(""));
    } else {
      (open ??= []).push(inlineText(node, serializer));
    }
  });
  if (open) lines.push((open as string[]).join(""));
  return lines.join("\n");
}

/** The document → its text. O(document): read at send, at the debounced
 *  draft flush and on copy, never per keystroke. */
export function docToText(doc: PMNode, serializer: ComposerSerializer): string {
  return fragmentToText(doc.content, serializer);
}

/** Every chip node of type `name`, in reading order. */
export function docChips(doc: PMNode, name: string): PMNode[] {
  const out: PMNode[] = [];
  doc.descendants((node) => {
    if (node.type.name === name) out.push(node);
    return !node.isInline;
  });
  return out;
}

/** Whether the text would trim to nothing — "can send". Runs on every doc
 *  change, so it stops at the first chip or non-space character rather than
 *  serializing: on a real draft that is the first node or two, however long
 *  the document is. */
export function isDocBlank(doc: PMNode): boolean {
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i);
    for (let j = 0; j < block.childCount; j++) {
      const node = block.child(j);
      if (!node.isText || /\S/.test(node.text ?? "")) return false;
    }
  }
  return true;
}

/** Whether the document is one empty line — the placeholder's condition. */
export function isDocEmpty(doc: PMNode): boolean {
  return doc.childCount === 1 && doc.child(0).content.size === 0;
}

function textLength(node: PMNode, serializer: ComposerSerializer): number {
  return node.isText ? (node.text?.length ?? 0) : inlineText(node, serializer).length;
}

/** Text offset → document position, under the same serializer. A chip counts
 *  as its whole text; an offset inside one lands after it. For callers that
 *  edit by string offsets (a markdown toolbar's `{value, start, end}`). */
export function textOffsetToPos(
  doc: PMNode,
  offset: number,
  serializer: ComposerSerializer,
): number {
  let remaining = Math.max(0, offset);
  let blockStart = 1;
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i);
    let at = blockStart;
    for (let j = 0; j < block.childCount; j++) {
      const child = block.child(j);
      const len = textLength(child, serializer);
      if (child.isText ? remaining <= len : remaining === 0) return at + remaining;
      if (remaining <= len) return at + child.nodeSize;
      remaining -= len;
      at += child.nodeSize;
    }
    if (remaining === 0 || i === doc.childCount - 1) return at;
    remaining -= 1; // the newline
    blockStart += block.nodeSize;
  }
  return blockStart;
}

/** Document position → text offset; the inverse of `textOffsetToPos`. */
export function posToTextOffset(doc: PMNode, pos: number, serializer: ComposerSerializer): number {
  let offset = 0;
  let blockStart = 1;
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i);
    let at = blockStart;
    for (let j = 0; j < block.childCount; j++) {
      const child = block.child(j);
      if (pos <= at) return offset;
      if (child.isText && pos < at + child.nodeSize) return offset + (pos - at);
      offset += textLength(child, serializer);
      at += child.nodeSize;
    }
    if (pos <= at || i === doc.childCount - 1) return offset;
    offset += 1; // the newline
    blockStart += block.nodeSize;
  }
  return offset;
}

/** Pasted text over either limit rides as an attachment rather than landing
 *  in the editor. A wall of log output or a whole file is something the
 *  reader opens, not something the writer edits — and as editor text it makes
 *  every later keystroke pay for its layout. */
export const LARGE_PASTE_CHARS = 4000;
export const LARGE_PASTE_LINES = 80;

export function isLargePaste(text: string): boolean {
  if (text.length > LARGE_PASTE_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines > LARGE_PASTE_LINES) return true;
  }
  return false;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Code fences the way CommonMark reads them, one line at a time. A fence
 * opens on three or more backticks or tildes (a backtick fence's info string
 * may not hold a backtick) and closes only on the same character, at least as
 * many of it, and nothing after but whitespace. So ```` ```js ```` inside an
 * open fence is code, and `~~~` fences count too.
 */
export class FenceTracker {
  private marker: { char: string; length: number } | null = null;

  /** Whether the lines fed so far leave a fence open. */
  get open(): boolean {
    return this.marker !== null;
  }

  /** Feed the next line. True when it is fence markup or fenced code. */
  line(text: string): boolean {
    if (!this.marker) {
      const m = FENCE_OPEN.exec(text);
      if (!m || (m[1][0] === "`" && m[2].includes("`"))) return false;
      this.marker = { char: m[1][0], length: m[1].length };
      return true;
    }
    const m = FENCE_CLOSE.exec(text);
    if (m && m[1][0] === this.marker.char && m[1].length >= this.marker.length) {
      this.marker = null;
    }
    return true;
  }
}
