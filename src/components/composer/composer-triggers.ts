// Picker triggers (`@`, `/`, …) for a composer, and the keys an open picker
// takes over.
//
// One ProseMirror plugin. Its view watches doc + selection changes, works out
// which trigger (if any) the caret sits in, and reports it; its
// `handleKeyDown` offers Up/Down/Enter/Escape/Backspace/Tab to the feature's
// interceptor first. The pickers themselves are the feature's React, fed the
// trigger as props.
//
// Why not `@tiptap/suggestion`: it always exits on Escape, and a picker with
// levels (the session mention picker's past-session messages) needs Escape to
// go BACK a level with the picker still open. It also paints a decoration over
// the query on every keystroke, which nothing here wants. The detection rule
// is the one the CodeMirror composers used:
//
//   - Scan backward from the caret, within the line, for a trigger char.
//     Whitespace first means no trigger: the char must start the token being
//     typed.
//   - The char must follow whitespace, `(`, `[` or the line start, so
//     `email@domain`, `C#` and `a/b` never open a picker.
//
// Positions are ProseMirror positions; the feature hands them back to the
// editor handle (`replaceRange`, `insertChip`) and does no arithmetic on them.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

export interface ComposerTrigger {
  /** Which char opened it. */
  char: string;
  /** Position of the trigger char (inclusive). */
  from: number;
  /** Caret position (exclusive). The typed query is between them. */
  to: number;
  /** What the user typed after the trigger char. */
  query: string;
  /** Is the trigger char the document's first character? */
  atStart: boolean;
  /** Viewport coords of the trigger char — the popover's anchor. */
  anchor: { x: number; y: number };
}

export interface ComposerTriggerSpec {
  /** Every char that opens this picker (`"@~"` → either). */
  chars: string;
  onChange: (trigger: ComposerTrigger | null) => void;
}

export type ComposerKey = "Up" | "Down" | "Enter" | "Escape" | "Backspace" | "Tab";
/** Returns true to swallow the key (a picker handled it). */
export type ComposerKeyInterceptor = (key: ComposerKey) => boolean;

export interface ComposerTriggerOptions {
  /** Read on every update, so a feature can change them without a rebuild. */
  getTriggers: () => readonly ComposerTriggerSpec[];
  getKeyInterceptor: () => ComposerKeyInterceptor | null;
}

const KEYS: Record<string, ComposerKey> = {
  ArrowUp: "Up",
  ArrowDown: "Down",
  Enter: "Enter",
  Escape: "Escape",
  Backspace: "Backspace",
  Tab: "Tab",
};

/** A chip reads as one non-space character, so a trigger char straight after
 *  a chip does not open a picker — what the CodeMirror composers did too,
 *  where the chip's token text sat in that spot. */
const LEAF_CHAR = "￼";

function findTrigger(
  view: EditorView,
  chars: string,
): Omit<ComposerTrigger, "anchor" | "to"> | null {
  const { selection } = view.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, LEAF_CHAR);
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i];
    if (chars.includes(ch)) {
      const prev = i > 0 ? before[i - 1] : "";
      if (prev && !/\s/.test(prev) && prev !== "(" && prev !== "[") return null;
      const from = $from.start() + i;
      // Position 1 is the first paragraph's first character.
      return { char: ch, from, query: before.slice(i + 1), atStart: from === 1 };
    }
    if (/\s/.test(ch)) return null;
  }
  return null;
}

function same(a: ComposerTrigger | null, b: ComposerTrigger | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.char === b.char &&
    a.from === b.from &&
    a.to === b.to &&
    a.query === b.query &&
    a.atStart === b.atStart &&
    a.anchor.x === b.anchor.x &&
    a.anchor.y === b.anchor.y
  );
}

const key = new PluginKey("atlas-composer-triggers");

export const ComposerTriggers = Extension.create<ComposerTriggerOptions>({
  name: "atlasComposerTriggers",
  // Above the composer keymap: Enter with a picker open selects; it does not
  // send or continue a list.
  priority: 1000,

  addOptions() {
    return { getTriggers: () => [], getKeyInterceptor: () => null };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key,
        view(view) {
          const last = new Map<ComposerTriggerSpec, ComposerTrigger | null>();
          let ticket = 0;
          let alive = true;

          // Coordinates are a layout read, so they wait for the update to
          // commit; a newer update supersedes a pending one.
          const schedule = () => {
            const mine = ++ticket;
            queueMicrotask(() => {
              if (!alive || mine !== ticket || !view.dom.isConnected) return;
              for (const spec of options.getTriggers()) {
                const found = findTrigger(view, spec.chars);
                let next: ComposerTrigger | null = null;
                if (found) {
                  try {
                    const c = view.coordsAtPos(found.from);
                    next = {
                      ...found,
                      to: view.state.selection.from,
                      anchor: { x: c.left, y: c.top },
                    };
                  } catch {
                    next = null;
                  }
                }
                if (!same(last.get(spec) ?? null, next)) {
                  last.set(spec, next);
                  spec.onChange(next);
                }
              }
            });
          };
          schedule();
          return {
            update(v, prev) {
              if (v.state.doc === prev.doc && v.state.selection.eq(prev.selection)) return;
              schedule();
            },
            destroy() {
              alive = false;
            },
          };
        },
        props: {
          handleKeyDown(view, event) {
            const name = KEYS[event.key];
            if (!name || view.composing) return false;
            if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return false;
            // Shift+Enter is a newline and Shift+Tab an outdent whatever is
            // open; only the bare keys belong to a picker.
            if (event.shiftKey) return false;
            const intercept = options.getKeyInterceptor();
            if (!intercept || !intercept(name)) return false;
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
