// CodeMirror extension: ask the agent about a line or a selection.
//
// Three ways in, all ending in the same `AskHandler` call (lines, their text,
// and a rect to grow the ask box from):
// - hovering a line shows an Ask button in its own gutter;
// - a selection shows a small "Ask ⌘↵" tooltip at its head (focused editor
//   only, and not while the pointer is still dragging it out);
// - ⌘↵ (Ctrl+↵ off macOS) asks about the selection, or the cursor's line.
//
// Hover is editor state, not React state: the pointer crossing into another
// line dispatches one effect, the gutter redraws its one marker, and nothing
// above the view re-renders.

import {
  EditorView,
  gutter,
  GutterMarker,
  keymap,
  showTooltip,
  ViewPlugin,
  type Tooltip,
} from "@codemirror/view";
import {
  Prec,
  RangeSet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Text,
} from "@codemirror/state";
import { isMac } from "@/lib/platform";

/** 1-based, inclusive line numbers. */
export interface AskLines {
  from: number;
  to: number;
}

/** Ask about `lines` (whose text is `excerpt`), growing the box from `anchor`. */
export type AskHandler = (lines: AskLines, excerpt: string, anchor: DOMRect) => void;

/**
 * The lines an ask is about: the main selection's when it is not empty (and,
 * given `line`, covers it), else `line`, else the cursor's. A selection that
 * ends at the very start of a line (a whole-line selection) leaves that line
 * out. Pure.
 */
export function askLinesAt(state: EditorState, line?: number): AskLines {
  const sel = state.selection.main;
  if (!sel.empty) {
    const from = state.doc.lineAt(sel.from).number;
    let to = state.doc.lineAt(sel.to).number;
    if (to > from && state.doc.line(to).from === sel.to) to -= 1;
    if (line === undefined || (line >= from && line <= to)) return { from, to };
  }
  const at = line ?? state.doc.lineAt(sel.head).number;
  return { from: at, to: at };
}

/** The text of `lines`. */
export function excerptOf(doc: Text, lines: AskLines): string {
  return doc.sliceString(doc.line(lines.from).from, doc.line(lines.to).to);
}

/** The pointer is over this line (its start), or over no line. Exported for
 *  tests, which have no layout to hover over. */
export const setHover = StateEffect.define<number | null>();
/** A button is down in the text: a selection is being dragged out. */
const setPressing = StateEffect.define<boolean>();

interface AskUi {
  hover: number | null;
  pressing: boolean;
}

const askUi = StateField.define<AskUi>({
  create: () => ({ hover: null, pressing: false }),
  update(value, tr) {
    let next = value;
    // An edit moves lines under the pointer; the next move puts it back.
    if (tr.docChanged && next.hover !== null) next = { ...next, hover: null };
    for (const e of tr.effects) {
      if (e.is(setHover) && e.value !== next.hover) next = { ...next, hover: e.value };
      else if (e.is(setPressing) && e.value !== next.pressing)
        next = { ...next, pressing: e.value };
    }
    return next;
  },
});

/** Where the box grows from: under the last asked line, at the start of the
 *  text, kept inside the scroller when that line is scrolled away. */
export function askAnchorRect(view: EditorView, lines: AskLines): DOMRect {
  const block = view.lineBlockAt(view.state.doc.line(lines.to).from);
  const content = view.contentDOM.getBoundingClientRect();
  const scroller = view.scrollDOM.getBoundingClientRect();
  const clamp = (y: number) => Math.min(Math.max(y, scroller.top), scroller.bottom);
  const top = clamp(view.documentTop + block.top);
  const bottom = clamp(view.documentTop + block.bottom);
  return new DOMRect(content.left, top, 0, bottom - top);
}

function ask(view: EditorView, onAsk: () => AskHandler | undefined, line?: number): boolean {
  const handler = onAsk();
  if (!handler) return false;
  const lines = askLinesAt(view.state, line);
  handler(lines, excerptOf(view.state.doc, lines), askAnchorRect(view, lines));
  return true;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide's `message-square-plus`, the glyph every Ask button wears
 *  (`AskAgentButton`), drawn without React. */
function askGlyph(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  for (const d of [
    "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
    "M12 8v6",
    "M9 11h6",
  ]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

const ASK_KEYS = isMac ? "⌘↵" : "Ctrl+↵";

class AskMarker extends GutterMarker {
  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    // Pointer only: the keyboard asks with ⌘↵, from the text.
    button.tabIndex = -1;
    button.className = "cm-ask-button";
    button.setAttribute("aria-label", "Ask agent about this line");
    button.title = `Ask agent (${ASK_KEYS})`;
    button.appendChild(askGlyph());
    return button;
  }
}
const ASK_MARKER = new AskMarker();

/** The gutter's markers, one set per hover state, so the gutter sees the
 *  same set until the hovered line moves (and each view its own). */
const markerSets = new WeakMap<AskUi, RangeSet<GutterMarker>>();
function markersFor(ui: AskUi): RangeSet<GutterMarker> {
  let set = markerSets.get(ui);
  if (!set) {
    set = ui.hover === null ? RangeSet.empty : RangeSet.of([ASK_MARKER.range(ui.hover)]);
    markerSets.set(ui, set);
  }
  return set;
}

/** Track the pointer's line over the whole editor (text and gutters, so
 *  moving onto the button keeps it), and whether a drag is under way. */
const pointerTracker = ViewPlugin.define((view) => {
  const hoverAt = (e: MouseEvent): number | null => {
    const y = e.clientY - view.documentTop;
    if (y < 0 || y > view.contentHeight) return null;
    return view.lineBlockAtHeight(y).from;
  };
  const onMove = (e: MouseEvent) => {
    const hover = hoverAt(e);
    if (hover !== view.state.field(askUi).hover) view.dispatch({ effects: setHover.of(hover) });
  };
  const onLeave = () => {
    if (view.state.field(askUi).hover !== null) view.dispatch({ effects: setHover.of(null) });
  };
  const onUp = () => {
    window.removeEventListener("mouseup", onUp);
    if (view.state.field(askUi).pressing) view.dispatch({ effects: setPressing.of(false) });
  };
  const onDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    window.addEventListener("mouseup", onUp);
    view.dispatch({ effects: setPressing.of(true) });
  };
  view.dom.addEventListener("mousemove", onMove);
  view.dom.addEventListener("mouseleave", onLeave);
  view.contentDOM.addEventListener("mousedown", onDown);
  return {
    destroy() {
      view.dom.removeEventListener("mousemove", onMove);
      view.dom.removeEventListener("mouseleave", onLeave);
      view.contentDOM.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
    },
  };
});

/** Where the chip sits: at the end the selection was drawn to (above it
 *  when that is the top), from the start of that line, so it lines up with
 *  the code, is never pushed off the right edge by a long line, and stays
 *  still while the head moves along the line. Null: no chip. */
function chipPlace(state: EditorState): { pos: number; above: boolean } | null {
  const sel = state.selection.main;
  if (sel.empty || state.field(askUi).pressing) return null;
  return { pos: state.doc.lineAt(sel.head).from, above: sel.head === sel.from };
}

function selectionTooltip(onAsk: () => AskHandler | undefined): Extension {
  // A field, not a compute over the selection and the hover: the tooltip
  // object (and so its DOM) is replaced only when the chip moves, never as
  // the pointer crosses lines.
  const field = StateField.define<Tooltip | null>({
    create: (state) => chipFor(chipPlace(state)),
    update(value, tr) {
      if (!tr.docChanged && !tr.selection && tr.effects.length === 0) return value;
      const place = chipPlace(tr.state);
      if (!place) return null;
      if (value && value.pos === place.pos && value.above === place.above) return value;
      return chipFor(place);
    },
    provide: (f) => showTooltip.from(f),
  });
  function chipFor(place: { pos: number; above: boolean } | null): Tooltip | null {
    if (!place) return null;
    return {
      pos: place.pos,
      above: place.above,
      arrow: false,
      create: (view) => {
        const dom = document.createElement("div");
        const button = document.createElement("button");
        button.type = "button";
        button.tabIndex = -1;
        button.className = "cm-ask-chip";
        button.appendChild(askGlyph());
        const label = document.createElement("span");
        label.textContent = "Ask";
        const keys = document.createElement("kbd");
        keys.className = "cm-ask-keys";
        keys.textContent = ASK_KEYS;
        button.append(label, keys);
        // Keep the selection and the focus: the box reads both.
        button.addEventListener("mousedown", (e) => e.preventDefault());
        button.addEventListener("click", () => void ask(view, onAsk));
        dom.className = "cm-ask-tooltip";
        dom.appendChild(button);
        return { dom, offset: { x: 0, y: 4 } };
      },
    };
  }
  return field;
}

// Colours are theme variables, so a theme swap repaints them with no
// subscription (`theme-subscription-contract.test.ts`).
const askTheme = EditorView.baseTheme({
  ".cm-ask-gutter": { width: "18px", minWidth: "18px" },
  ".cm-ask-gutter .cm-gutterElement": {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "0",
  },
  ".cm-ask-button": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "16px",
    height: "16px",
    marginTop: "1px",
    padding: "0",
    border: "none",
    borderRadius: "var(--radius-sm)",
    background: "transparent",
    color: "var(--muted-foreground)",
    cursor: "pointer",
  },
  ".cm-ask-button:hover": {
    background: "var(--element-hover)",
    color: "var(--foreground)",
  },
  ".cm-tooltip.cm-ask-tooltip": {
    border: "none",
    background: "transparent",
  },
  // A selection in an editor that has lost the focus asks nothing.
  "&:not(.cm-focused) .cm-ask-tooltip": { display: "none" },
  ".cm-ask-chip": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    height: "22px",
    padding: "0 6px",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-md)",
    background: "var(--popover)",
    color: "var(--popover-foreground)",
    boxShadow: "var(--shadow-md)",
    font: "inherit",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-2xs)",
    cursor: "pointer",
  },
  ".cm-ask-chip:hover": { background: "var(--element-hover)" },
  ".cm-ask-keys": {
    fontFamily: "inherit",
    color: "var(--muted-foreground)",
  },
});

/**
 * The ask affordances. `onAsk` is read at the moment of asking, so the caller
 * can hand it the latest props without reconfiguring the view.
 */
export function askAgentGutter(onAsk: () => AskHandler | undefined): Extension {
  return [
    askUi,
    pointerTracker,
    gutter({
      class: "cm-ask-gutter",
      markers: (view) => markersFor(view.state.field(askUi)),
      domEventHandlers: {
        mousedown: (_view, _line, event) => {
          if (!(event.target as Element).closest?.(".cm-ask-button")) return false;
          // The selection and focus stay where they were.
          event.preventDefault();
          return true;
        },
        click: (view, line, event) => {
          if (!(event.target as Element).closest?.(".cm-ask-button")) return false;
          return ask(view, onAsk, view.state.doc.lineAt(line.from).number);
        },
      },
    }),
    selectionTooltip(onAsk),
    Prec.highest(keymap.of([{ key: "Mod-Enter", run: (view) => ask(view, onAsk) }])),
    askTheme,
  ];
}
