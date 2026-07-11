// CodeMirror extension: Zed-style inline Git blame. Renders a dim, trailing
// annotation at the end of the *active* line only — "Author, 3 days ago ·
// commit summary" — fed by the native `git_blame_file` engine via `setBlame`.
//
// Blame is stored as a RangeSet keyed per line, so it auto-shifts as the doc is
// edited; lines the user touches are dropped from the set and fall back to an
// "Uncommitted changes" annotation instead of showing another commit's info.

import {
  EditorView,
  Decoration,
  WidgetType,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  StateField,
  StateEffect,
  RangeSet,
  RangeValue,
  type Extension,
  type Text,
} from "@codemirror/state";
import type { BlameLine } from "@/features/git/lib/git-blame-api";

/** Push a fresh blame snapshot into the editor. An empty array clears it
 *  (used for untracked files / non-repos → nothing is shown). */
export const setBlame = StateEffect.define<BlameLine[]>();

/** Convenience: dispatch a blame update onto a view. */
export function applyBlame(view: EditorView, lines: BlameLine[]): void {
  view.dispatch({ effects: setBlame.of(lines) });
}

// A per-line point value carrying that line's committed blame.
class BlameValue extends RangeValue {
  constructor(readonly info: BlameLine) {
    super();
  }
}

// null  = no blame loaded (not a repo / untracked) → render nothing.
// RangeSet (possibly empty) = loaded; lines absent from it are uncommitted.
type BlameState = RangeSet<BlameValue> | null;

function buildSet(doc: Text, lines: BlameLine[]): BlameState {
  if (lines.length === 0) return null;
  const ranges: { from: number; value: BlameValue }[] = [];
  for (const b of lines) {
    if (!b.committed) continue; // uncommitted lines carry no marker
    if (b.line < 1 || b.line > doc.lines) continue;
    ranges.push({ from: doc.line(b.line).from, value: new BlameValue(b) });
  }
  ranges.sort((a, z) => a.from - z.from);
  return RangeSet.of(
    ranges.map((r) => r.value.range(r.from)),
    /* sort */ true,
  );
}

const blameField = StateField.define<BlameState>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setBlame)) return buildSet(tr.state.doc, e.value);
    }
    if (value === null || !tr.docChanged) return value;
    // Shift markers through the edit, then drop any line the edit touched so it
    // reads as uncommitted rather than showing stale attribution.
    let set = value.map(tr.changes);
    const drop = new Set<number>();
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      const first = tr.state.doc.lineAt(fromB).number;
      const last = tr.state.doc.lineAt(toB).number;
      for (let n = first; n <= last; n++) drop.add(tr.state.doc.line(n).from);
    });
    if (drop.size) set = set.update({ filter: (from) => !drop.has(from) });
    return set;
  },
});

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  const wk = Math.floor(day / 7);
  if (day < 30) return `${wk} week${wk === 1 ? "" : "s"} ago`;
  const mo = Math.floor(day / 30);
  if (day < 365) return `${mo} month${mo === 1 ? "" : "s"} ago`;
  const yr = Math.floor(day / 365);
  return `${yr} year${yr === 1 ? "" : "s"} ago`;
}

function formatBlame(info: BlameLine): string {
  const rel = relativeTime(info.timeMs);
  const when = rel ? `, ${rel}` : "";
  const summary = info.summary ? ` · ${truncate(info.summary, 60)}` : "";
  return `${info.author}${when}${summary}`;
}

class BlameWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly uncommitted: boolean,
  ) {
    super();
  }
  eq(other: BlameWidget) {
    return other.text === this.text && other.uncommitted === this.uncommitted;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-inline-blame" + (this.uncommitted ? " cm-inline-blame-uncommitted" : "");
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return true;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state.field(blameField, false);
  if (state === undefined || state === null) return Decoration.none;
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.head);
  // Don't annotate an empty line — nothing to attribute, and it looks noisy.
  if (line.length === 0) return Decoration.none;

  let info: BlameLine | null = null;
  state.between(line.from, line.from, (_from, _to, value) => {
    info = value.info;
    return false;
  });

  const text = info ? formatBlame(info) : "You · Uncommitted changes";
  const widget = Decoration.widget({
    widget: new BlameWidget(text, !info),
    side: 1,
  });
  return Decoration.set([widget.range(line.to)]);
}

const blamePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.transactions.some((t) => t.effects.some((e) => e.is(setBlame)))
      ) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const blameTheme = EditorView.baseTheme({
  ".cm-inline-blame": {
    marginLeft: "2.5em",
    color: "var(--text-tertiary, #6b7280)",
    opacity: "0.65",
    fontStyle: "italic",
    fontSize: "0.9em",
    userSelect: "none",
    pointerEvents: "none",
    whiteSpace: "pre",
  },
  ".cm-inline-blame-uncommitted": {
    opacity: "0.5",
  },
});

/** The inline-blame extension. Add to the editor's extensions, then dispatch
 *  `setBlame` effects (via `applyBlame`) to populate it. Leaving it out of the
 *  extension set entirely disables the feature with zero overhead. */
export function inlineBlame(): Extension {
  return [blameField, blamePlugin, blameTheme];
}
