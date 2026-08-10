// CodeMirror extension: inline Git blame on the active line only — a dim
// trailing "Author, 3 days ago · commit summary" annotation that follows the
// cursor. Fed by the native `git_blame_file` engine via the `setBlame` effect.
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

function relativeTime(ms: number): string {
  if (!ms) return "";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return d === 1 ? "1 day ago" : `${d} days ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo === 1 ? "1 month ago" : `${mo} months ago`;
  const y = Math.floor(d / 365);
  return y <= 1 ? "1 year ago" : `${y} years ago`;
}

class BlameWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: BlameWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-blame-inline";
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

function blameTextFor(state: BlameState, doc: Text, head: number): string | null {
  if (state === null) return null;
  const line = doc.lineAt(head);
  let found: BlameLine | null = null;
  state.between(line.from, line.from, (_f, _t, v) => {
    found = v.info;
    return false;
  });
  if (found === null) return "You · Uncommitted changes";
  const b: BlameLine = found;
  const when = relativeTime(b.timeMs);
  return `${b.author}${when ? `, ${when}` : ""} · ${b.summary}`;
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
      const text = blameTextFor(
        view.state.field(blameField),
        view.state.doc,
        view.state.selection.main.head,
      );
      if (text === null) return Decoration.none;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      const deco = Decoration.widget({ widget: new BlameWidget(text), side: 1 });
      return Decoration.set([deco.range(line.to)]);
    }
  },
  { decorations: (v) => v.decorations },
);

const blameTheme = EditorView.baseTheme({
  ".cm-blame-inline": {
    marginLeft: "2em",
    color: "var(--text-tertiary, #6b7280)",
    opacity: "0.65",
    fontStyle: "italic",
    fontSize: "0.9em",
    whiteSpace: "pre",
    pointerEvents: "none",
    userSelect: "none",
  },
});

/** The inline-blame extension. Add to the editor's extensions, then dispatch
 *  `setBlame` snapshots (via `applyBlame`) to populate it. */
export function blameInline(): Extension {
  return [blameField, blameDecorations, blameTheme];
}
