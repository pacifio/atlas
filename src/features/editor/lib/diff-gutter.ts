// CodeMirror extension: a dedicated change-bar gutter (VS Code-style) showing
// green/blue/red bars for added / changed / deleted-before lines vs git HEAD.
// Fed by the native `git_diff_line_status` engine via the `setDiffStatus` effect.

import { EditorView, gutter, GutterMarker } from "@codemirror/view";
import { StateField, StateEffect, RangeSet, type Extension, type Text } from "@codemirror/state";
import type { DiffLineStatus } from "@/features/git/lib/git-diff-api";

/** Push a fresh line-status snapshot into the gutter. */
const setDiffStatus = StateEffect.define<DiffLineStatus>();

class BarMarker extends GutterMarker {
  constructor(readonly cls: string) {
    super();
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cm-changebar ${this.cls}`;
    return el;
  }
}

const ADDED = new BarMarker("cm-changebar-added");
const CHANGED = new BarMarker("cm-changebar-changed");
const DELETED = new BarMarker("cm-changebar-deleted");

function buildMarkers(doc: Text, status: DiffLineStatus): RangeSet<GutterMarker> {
  const total = doc.lines;
  const entries: { pos: number; marker: GutterMarker }[] = [];
  const add = (lineNo: number, marker: GutterMarker) => {
    if (lineNo < 1 || lineNo > total) return;
    entries.push({ pos: doc.line(lineNo).from, marker });
  };
  for (const n of status.added) add(n, ADDED);
  for (const n of status.changed) add(n, CHANGED);
  for (const n of status.deletedBefore) add(n, DELETED);
  entries.sort((a, b) => a.pos - b.pos);
  return RangeSet.of(
    entries.map((e) => e.marker.range(e.pos)),
    /* sort */ true,
  );
}

const diffStatusField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setDiffStatus)) {
        return buildMarkers(tr.state.doc, e.value);
      }
    }
    return tr.docChanged ? value.map(tr.changes) : value;
  },
});

const diffGutterTheme = EditorView.baseTheme({
  ".cm-changebar-gutter": {
    width: "3px",
    minWidth: "3px",
    padding: "0",
  },
  ".cm-changebar-gutter .cm-gutterElement": {
    padding: "0",
  },
  ".cm-changebar": {
    width: "3px",
    height: "100%",
    boxSizing: "border-box",
  },
  ".cm-changebar-added": {
    background: "var(--atlas-diff-added-text)",
  },
  // There's no dedicated "changed" role in the diff theme keys (only
  // added/removed/context) — this is a status colour by design.
  ".cm-changebar-changed": {
    // The diff palette's changed-line colour, so `diffPalette` re-tints it.
    background: "var(--atlas-diff-changed-bar)",
  },
  // A deletion has no line of its own in the new file — mark the following
  // line's bar with a downward red wedge.
  ".cm-changebar-deleted": {
    background: "transparent",
    borderTop: "2px solid var(--atlas-diff-removed-text)",
  },
});

/** The change-bar gutter extension. Add to the editor's extensions, then
 *  dispatch `setDiffStatus` effects (via `applyDiffStatus`) to populate it. */
export function diffGutter(): Extension {
  return [
    diffStatusField,
    gutter({
      class: "cm-changebar-gutter",
      markers: (view) => view.state.field(diffStatusField),
    }),
    diffGutterTheme,
  ];
}

/** Convenience: dispatch a line-status update onto a view. */
export function applyDiffStatus(view: EditorView, status: DiffLineStatus): void {
  view.dispatch({ effects: setDiffStatus.of(status) });
}
