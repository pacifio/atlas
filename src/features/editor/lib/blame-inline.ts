// CodeMirror extension: inline Git blame on the active line only — a dim
// trailing "Author, 3 days ago · commit summary" annotation that follows the
// cursor. Each part takes a syntax colour from the theme (author, time,
// summary) so the line parses at a glance instead of reading as one grey run. Fed by the native `git_blame_file` engine via the `setBlame` effect.
//
// Committed lines live in a RangeSet keyed by line start, so attribution
// shifts correctly through edits; any line the user touches (and any line git
// already reports as uncommitted) falls back to "You · Uncommitted changes"
// instead of ever showing another commit's info.

import { EditorView, Decoration, WidgetType, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { StateField, StateEffect, RangeSet, RangeValue } from "@codemirror/state";
import type { Extension, Text } from "@codemirror/state";
import type { BlameLine } from "@/features/git/lib/git-blame-api";

/** Push a fresh blame snapshot into the editor. An empty array clears the
 *  state entirely (untracked file / not a repo → nothing is rendered). */
const setBlame = StateEffect.define<BlameLine[]>();

// The trailing annotation reads a notch below the editor body; the previous
// `0.9em` (~11.7px against the editor's 13px body) rounds onto the text-sm
// (12px) step.
const BLAME_FONT_SIZE = "var(--text-sm)";

/** Convenience: dispatch a blame snapshot onto a view. */
export function applyBlame(view: EditorView, lines: BlameLine[]): void {
  view.dispatch({ effects: setBlame.of(lines) });
}

class BlameValue extends RangeValue {
  constructor(readonly info: BlameLine) {
    super();
  }
}

// null = no blame loaded → render nothing at all.
// RangeSet = loaded; only committed lines are in the set, so an active line
// absent from it renders the "Uncommitted changes" fallback.
type BlameState = RangeSet<BlameValue> | null;

function buildSet(doc: Text, lines: BlameLine[]): BlameState {
  const entries: { from: number; value: BlameValue }[] = [];
  for (const b of lines) {
    if (!b.committed) continue;
    if (b.line < 1 || b.line > doc.lines) continue;
    entries.push({ from: doc.line(b.line).from, value: new BlameValue(b) });
  }
  if (entries.length === 0) return lines.length === 0 ? null : RangeSet.empty;
  entries.sort((a, z) => a.from - z.from);
  return RangeSet.of(
    entries.map((e) => e.value.range(e.from)),
    /* sort */ true,
  );
}

const blameField = StateField.define<BlameState>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setBlame)) return e.value.length === 0 ? null : buildSet(tr.state.doc, e.value);
    }
    if (value === null || !tr.docChanged) return value;
    // Shift markers through the edit, then drop every line the edit touched so
    // it reads as uncommitted rather than keeping stale attribution.
    let set = value.map(tr.changes);
    const touched = new Set<number>();
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const first = tr.state.doc.lineAt(fromB).number;
      const last = tr.state.doc.lineAt(toB).number;
      for (let n = first; n <= last; n++) touched.add(tr.state.doc.line(n).from);
    });
    if (touched.size) set = set.update({ filter: (from) => !touched.has(from) });
    return set;
  },
});

/**
 * git's own relative date (`show_date_relative` in git's `date.c`), the `%cr`
 * that Source Control → History prints for the same commit. Each step rounds
 * to nearest and has git's thresholds; the floor-everything version this
 * replaced put "22 hours ago" on the line and "23 hours ago" in History.
 */
export function relativeTime(ms: number, now = Date.now()): string {
  if (!ms) return "";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  let diff = Math.max(0, Math.floor((now - ms) / 1000));
  if (diff < 90) return unit(diff, "second");
  diff = Math.floor((diff + 30) / 60);
  if (diff < 90) return unit(diff, "minute");
  diff = Math.floor((diff + 30) / 60);
  if (diff < 36) return unit(diff, "hour");
  diff = Math.floor((diff + 12) / 24);
  if (diff < 14) return unit(diff, "day");
  if (diff < 70) return unit(Math.floor((diff + 3) / 7), "week");
  if (diff < 365) return unit(Math.floor((diff + 15) / 30), "month");
  if (diff < 1825) {
    const totalMonths = Math.floor((diff * 12 * 2 + 365) / (365 * 2));
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;
    const y = `${years} year${years === 1 ? "" : "s"}`;
    return months ? `${y}, ${unit(months, "month")}` : `${y} ago`;
  }
  return unit(Math.floor((diff + 183) / 365), "year");
}

/** One coloured run of the annotation; `kind` picks its `.cm-blame-<kind>` class. */
type BlamePart = { kind: "author" | "time" | "summary" | "uncommitted" | "sep"; text: string };

class BlameWidget extends WidgetType {
  constructor(readonly parts: BlamePart[]) {
    super();
  }
  eq(other: BlameWidget) {
    return (
      other.parts.length === this.parts.length &&
      other.parts.every((p, i) => p.kind === this.parts[i].kind && p.text === this.parts[i].text)
    );
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-blame-inline";
    for (const part of this.parts) {
      const span = document.createElement("span");
      span.className = `cm-blame-${part.kind}`;
      span.textContent = part.text;
      el.appendChild(span);
    }
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function blamePartsFor(state: BlameState, doc: Text, head: number): BlamePart[] | null {
  if (state === null) return null;
  const line = doc.lineAt(head);
  let found: BlameLine | null = null;
  state.between(line.from, line.from, (_f, _t, v) => {
    found = v.info;
    return false;
  });
  if (found === null) {
    return [
      { kind: "author", text: "You" },
      { kind: "sep", text: " · " },
      { kind: "uncommitted", text: "Uncommitted changes" },
    ];
  }
  const b: BlameLine = found;
  const when = relativeTime(b.timeMs);
  const parts: BlamePart[] = [{ kind: "author", text: b.author }];
  if (when) parts.push({ kind: "sep", text: ", " }, { kind: "time", text: when });
  parts.push({ kind: "sep", text: " · " }, { kind: "summary", text: b.summary });
  return parts;
}

const blameDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      const blameChanged = update.transactions.some((tr) => tr.effects.some((e) => e.is(setBlame)));
      if (update.docChanged || update.selectionSet || update.focusChanged || blameChanged) {
        this.decorations = this.build(update.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const parts = blamePartsFor(
        view.state.field(blameField),
        view.state.doc,
        view.state.selection.main.head,
      );
      if (parts === null) return Decoration.none;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const deco = Decoration.widget({ widget: new BlameWidget(parts), side: 1 });
      return Decoration.set([deco.range(line.to)]);
    }
  },
  { decorations: (v) => v.decorations },
);

const blameTheme = EditorView.baseTheme({
  ".cm-blame-inline": {
    // PADDING, never margin. With the cursor at the end of the line (the
    // widget sits at `line.to`), CodeMirror draws the caret at the widget's
    // box — and a margin lies outside that box, so the caret was drawn 2em
    // past the end of the text, which on an empty line looked like an indent
    // nobody typed. Padding keeps the gap inside the box, so its left edge is
    // the end of the text and the caret stays there.
    paddingLeft: "2em",
    color: "var(--muted-foreground)",
    // Higher than a plain grey annotation would need: the parts are told apart
    // by hue, and at 0.65 the syntax colours wash into one another.
    opacity: "0.8",
    fontStyle: "italic",
    fontSize: BLAME_FONT_SIZE,
    whiteSpace: "pre",
    pointerEvents: "none",
    userSelect: "none",
  },
  ".cm-blame-author": { color: "var(--syntax-function)" },
  ".cm-blame-time": { color: "var(--syntax-number)" },
  ".cm-blame-summary": { color: "var(--syntax-string)" },
  ".cm-blame-uncommitted": { color: "var(--syntax-keyword)" },
  ".cm-blame-sep": { color: "var(--syntax-comment)" },
});

/** The inline-blame extension. Add to the editor's extensions, then dispatch
 *  `setBlame` snapshots (via `applyBlame`) to populate it. */
export function blameInline(): Extension {
  return [blameField, blameDecorations, blameTheme];
}
