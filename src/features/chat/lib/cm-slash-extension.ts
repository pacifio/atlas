// CodeMirror trigger for the `/` slash-command picker. Mirrors the shape of
// `cm-mention-extension.ts`'s `mentionTriggerPlugin` + `mentionKeymap` so
// `message-input.tsx` can wire it identically.
//
// Differences vs mentions:
//   - `detectTrigger` below scans backward from the caret for a `/`
//     preceded by whitespace or start-of-line, same as the mention
//     extension's `@`/`~` scan — so a slash command can sit anywhere in the
//     message, not just at the very start.
//   - There is no document-level state field — selecting a command
//     either runs an app-level handler (e.g. `/login` opens a dialog) or
//     leaves the literal `/foo` text in place for passthrough commands.
//     Compare with the mention extension, which has to track chip ranges
//     across edits.

import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { MentionKeyInterceptor } from "./cm-mention-extension";

export interface SlashTrigger {
  /** Document position of the `/` (inclusive). */
  from: number;
  /** Caret position (exclusive). Slice [from+1, to] is the typed query. */
  to: number;
  /** What the user typed after the `/`. Empty right after the keystroke. */
  query: string;
  /** Viewport coords of the trigger position — anchor for the popover. */
  anchor: { x: number; y: number };
}

export type SlashKeyInterceptor = MentionKeyInterceptor;

export function slashTriggerPlugin(
  onChange: (trigger: SlashTrigger | null) => void,
): ViewPlugin<{ last: SlashTrigger | null; pending: number }> {
  return ViewPlugin.define((view) => {
    const state = {
      last: null as SlashTrigger | null,
      pending: 0,
    };
    schedule(view, state, onChange);
    return {
      update(u: ViewUpdate) {
        if (!u.docChanged && !u.selectionSet && !u.viewportChanged) return;
        schedule(u.view, state, onChange);
      },
    };
  });
}

function schedule(
  view: EditorView,
  state: { last: SlashTrigger | null; pending: number },
  onChange: (t: SlashTrigger | null) => void,
): void {
  const ticket = ++state.pending;
  queueMicrotask(() => {
    if (ticket !== state.pending) return;
    recompute(view, state, onChange);
  });
}

function recompute(
  view: EditorView,
  state: { last: SlashTrigger | null; pending: number },
  onChange: (t: SlashTrigger | null) => void,
): void {
  if (!view.dom.isConnected) return;
  const trig = detectTrigger(view);
  if (sameTrigger(state.last, trig)) return;
  state.last = trig;
  onChange(trig);
}

function sameTrigger(a: SlashTrigger | null, b: SlashTrigger | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.from === b.from &&
    a.to === b.to &&
    a.query === b.query &&
    a.anchor.x === b.anchor.x &&
    a.anchor.y === b.anchor.y
  );
}

function detectTrigger(view: EditorView): SlashTrigger | null {
  const sel = view.state.selection.main;
  if (!sel.empty) return null;
  const caret = sel.head;
  const line = view.state.doc.lineAt(caret);
  // Scan backward from the caret for the most recent `/` on this line,
  // stopping (no trigger) at the first whitespace encountered first. This
  // means the `/` must be part of the token currently being typed, mirroring
  // `cm-mention-extension.ts`'s `@`/`~` scan.
  const lineBefore = view.state.doc.sliceString(line.from, caret);
  for (let i = lineBefore.length - 1; i >= 0; i--) {
    const ch = lineBefore[i];
    if (ch === "/") {
      const prev = i > 0 ? lineBefore[i - 1] : "";
      if (prev && !/\s/.test(prev) && prev !== "(" && prev !== "[") {
        return null;
      }
      const from = line.from + i;
      const query = lineBefore.slice(i + 1);
      const coords = view.coordsAtPos(from);
      if (!coords) return null;
      return {
        from,
        to: caret,
        query,
        anchor: { x: coords.left, y: coords.top },
      };
    }
    if (/\s/.test(ch)) {
      return null;
    }
  }
  return null;
}

// `clearSlashRange` used to live here. It moved to `./cm-clear-range` — it
// needs no CodeMirror value import, and having the eager `message-input.tsx`
// import it from THIS module (which does) dragged the whole CodeMirror vendor
// chunk onto the boot path. See that file's header.
