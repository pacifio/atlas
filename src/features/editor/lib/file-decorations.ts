/**
 * What the file view paints over the code beyond its tokens: change bars
 * against HEAD, the cursor line's blame, and a revealed line's tint.
 *
 * All of it is one stylesheet of line-number selectors, written into the
 * viewer's shadow root. The viewer virtualizes, so most rows do not exist;
 * a rule keyed by line number applies to a row whenever it mounts, and
 * nothing has to follow the scroll. Writing the sheet touches no React state:
 * moving the cursor or typing repaints a `<style>`, never the tree.
 *
 * Line-keyed data moves with edits (`applyChanges`): lines below an edit
 * shift by the lines it added or removed, and a line the edit touched loses
 * its commit, so it reads as uncommitted rather than as someone else's work.
 */

import type { BlameLine } from "@/features/git/lib/git-blame-api";
import type { DiffLineStatus } from "@/features/git/lib/git-diff-api";
import { BLAME_PART_COLOR, blameParts, samePartsAs, type BlamePart } from "./blame";

/** An edit, as the viewer's editor reports it: zero-based lines before it. */
export interface LineEdit {
  readonly range: {
    readonly start: { readonly line: number };
    readonly end: { readonly line: number };
  };
  readonly start: number;
  readonly text: string;
}

function countNewlines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n += 1;
  return n;
}

/** `lines` moved through one edit. `touched` lines are dropped. */
function shiftLines<T>(
  lines: ReadonlyMap<number, T>,
  edit: LineEdit,
  dropTouched: boolean,
): Map<number, T> {
  const first = edit.range.start.line + 1;
  const last = edit.range.end.line + 1;
  const delta = countNewlines(edit.text) - (last - first);
  const out = new Map<number, T>();
  for (const [line, value] of lines) {
    if (line < first) out.set(line, value);
    else if (line > last) out.set(line + delta, value);
    else if (!dropTouched && line === first) out.set(line, value);
  }
  return out;
}

const cssString = (text: string) =>
  `"${text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\n\r]/g, " ")}"`;

/**
 * The inline note as one `::after`: a pseudo-element has one colour, so the
 * runs are a gradient clipped to the text, one stop per run. The note is
 * monospace, so `ch` lands each stop on its run's first character.
 */
function inlineBlameRule(line: number, parts: BlamePart[]): string {
  const text = parts.map((p) => p.text).join("");
  const stops: string[] = [];
  let at = 0;
  for (const part of parts) {
    const end = at + [...part.text].length;
    stops.push(`${BLAME_PART_COLOR[part.kind]} ${at}ch ${end}ch`);
    at = end;
  }
  return `[data-line="${line}"]::after {
  content: ${cssString(text)};
  padding-left: 2em;
  font-size: var(--text-sm);
  font-style: italic;
  white-space: pre;
  pointer-events: none;
  user-select: none;
  opacity: 0.8;
  color: transparent;
  background-image: linear-gradient(to right, ${stops.join(", ")});
  background-origin: content-box;
  background-clip: text;
  -webkit-background-clip: text;
  background-repeat: no-repeat;
}`;
}

function barRule(lines: Iterable<number>, color: string, size: string): string {
  const selectors = [...lines].map((n) => `[data-column-number="${n}"]`);
  if (selectors.length === 0) return "";
  return `:is(${selectors.join(",")}) {
  background-image: linear-gradient(${color}, ${color});
  background-size: ${size};
  background-position: left top;
  background-repeat: no-repeat;
}`;
}

type Bar = "added" | "changed" | "deleted";

export class FileDecorations {
  /** Committed lines' blame by current line. `null`: none loaded (no repo,
   *  untracked, or the setting is off), so nothing is drawn. */
  private blame: Map<number, BlameLine> | null = null;
  private bars = new Map<number, Bar>();
  private cursorLine: number | null = null;
  private revealLine: number | null = null;
  private wrap = false;
  private showBlame = false;
  private listeners = new Set<() => void>();
  private header: BlamePart[] | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit(): void {
    this.header = this.computeHeader();
    for (const listener of this.listeners) listener();
  }

  setBlame(lines: readonly BlameLine[] | null): void {
    if (lines === null || lines.length === 0) this.blame = null;
    else {
      this.blame = new Map();
      for (const line of lines) if (line.committed) this.blame.set(line.line, line);
    }
    this.emit();
  }

  setStatus(status: DiffLineStatus | null): void {
    this.bars = new Map();
    if (status) {
      for (const n of status.deletedBefore) this.bars.set(n, "deleted");
      for (const n of status.changed) this.bars.set(n, "changed");
      for (const n of status.added) this.bars.set(n, "added");
    }
    this.emit();
  }

  setCursorLine(line: number | null): void {
    if (line === this.cursorLine) return;
    this.cursorLine = line;
    this.emit();
  }

  setRevealLine(line: number | null): void {
    if (line === this.revealLine) return;
    this.revealLine = line;
    this.emit();
  }

  /** Word wrap on: the note goes to the header, never into the text, so a
   *  line's height never depends on where the cursor is. */
  setLayout(wrap: boolean, showBlame: boolean): void {
    if (wrap === this.wrap && showBlame === this.showBlame) return;
    this.wrap = wrap;
    this.showBlame = showBlame;
    this.emit();
  }

  applyChanges(edits: readonly LineEdit[]): void {
    if (edits.length === 0) return;
    // Latest offset first, so each edit's lines are still the document's
    // before any of the others moved them.
    const ordered = [...edits].sort((a, b) => b.start - a.start);
    for (const edit of ordered) {
      if (this.blame) this.blame = shiftLines(this.blame, edit, true);
      this.bars = shiftLines(this.bars, edit, false);
      if (this.revealLine !== null && this.revealLine > edit.range.end.line + 1) {
        this.revealLine += countNewlines(edit.text) - (edit.range.end.line - edit.range.start.line);
      }
    }
    this.emit();
  }

  private computeHeader(): BlamePart[] | null {
    if (!this.wrap || !this.showBlame || this.blame === null || this.cursorLine === null) {
      return null;
    }
    const next = blameParts(this.blame.get(this.cursorLine));
    return samePartsAs(next, this.header) ? this.header : next;
  }

  /** The cursor line's attribution for the header; null while it is inline. */
  headerBlame = (): BlamePart[] | null => this.header;

  css(): string {
    const rules: string[] = [];
    const by = (kind: Bar) => [...this.bars].filter(([, k]) => k === kind).map(([n]) => n);
    rules.push(barRule(by("added"), "var(--atlas-diff-added-text)", "3px 100%"));
    // No dedicated "changed" role in the diff keys: a status colour, which
    // `globals.css` swaps when the diff palette takes it for additions.
    rules.push(barRule(by("changed"), "var(--atlas-diff-changed-bar)", "3px 100%"));
    // A deletion has no line of its own; the following line's number gets a
    // short red rule along its top.
    rules.push(barRule(by("deleted"), "var(--atlas-diff-removed-text)", "8px 2px"));
    if (this.revealLine !== null) {
      // Through --diffs-line-bg, not background-color: the editor paints row
      // tints under its selection, and a row background would hide it.
      rules.push(`[data-line="${this.revealLine}"] {
  --diffs-line-bg: color-mix(in srgb, var(--atlas-editor-background) 75%, var(--atlas-editor-selection-background)) !important;
}`);
    }
    if (!this.wrap && this.showBlame && this.blame !== null && this.cursorLine !== null) {
      rules.push(inlineBlameRule(this.cursorLine, blameParts(this.blame.get(this.cursorLine))));
    }
    return rules.filter(Boolean).join("\n");
  }
}
