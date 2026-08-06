// A CodeMirror doc edit that needs NO CodeMirror import at runtime.
//
// This lives in its own module purely for chunking. `message-input.tsx` is on
// the app's eager boot path, and it deliberately loads the composer's editor
// (`./chat-input`) through a dynamic `import()` so the ~875 KB CodeMirror
// vendor chunk stays off the critical path. Importing this one function as a
// VALUE from `cm-slash-extension.ts` — which does `import { EditorView,
// ViewPlugin } from "@codemirror/view"` at module scope — silently undid that:
// Rollup pulled the whole chunk into the entry's static graph, and the built
// `index.html` preloaded it for a single class. The type import below is erased
// at compile time, so this module has no runtime edge to CodeMirror.

import type { EditorView } from "@codemirror/view";

/** Replace the doc range that holds the `/query` text with empty (used by
 *  the picker when an atlas-local command runs — we don't want the literal
 *  `/login` sitting in the composer afterwards). */
export function clearSlashRange(view: EditorView, from: number, to: number): void {
  view.dispatch({
    changes: { from, to, insert: "" },
    selection: { anchor: from },
  });
}
