// Ask the agent from the files viewer (`src/features/editor/`, the explorer).
//
// Opens `src/lib/api.ts` in its file tab, read-only, with the project tree
// beside it. Hover a line for the gutter's Ask button, select a range for
// the "Ask ⌘↵" chip, or press ⌘↵ in the text; the box opens under the lines
// with a file-range chip. ⌘E (or the pencil in the header) switches the tab
// into editing. A file row in the tree has Ask on hover and "Ask Agent About
// This File" in its context menu. Actions:
//
//   __atlasMock.actions.selectLines()     select lines 2–5, so the chip shows
//   __atlasMock.actions.askLines()        open the box as ⌘↵ would on them
//   __atlasMock.actions.openUnreadable()  a file that fails to load
//   __atlasMock.actions.failSaves()       every save fails from now on (edit, ⌘S)

import type { EditorView } from "@codemirror/view";
import type { Scenario } from "../types";
import { MOCK_PROJECT } from "../project";
import { fsHandlers } from "../fixtures/files";

const FILE = `${MOCK_PROJECT.path}/src/lib/api.ts`;

let savesFail = false;

/** The open file tab's editor, found the way CodeMirror finds it. */
async function fileView(): Promise<EditorView | null> {
  const { EditorView } = await import("@codemirror/view");
  const dom = document.querySelector<HTMLElement>("[data-file-view] .cm-editor");
  return dom ? EditorView.findFromDOM(dom) : null;
}

async function selectLines(): Promise<string | undefined> {
  const view = await fileView();
  if (!view) return "no file view yet";
  const doc = view.state.doc;
  view.focus();
  view.dispatch({ selection: { anchor: doc.line(2).from, head: doc.line(5).to } });
  return undefined;
}

export const askFiles: Scenario = {
  name: "ask-files",
  description: "A file open read-only, with Ask on lines, selections and tree rows.",
  commands: {
    write_file_content: (args) => {
      if (savesFail) throw new Error(`EACCES: permission denied, open '${String(args.path)}'`);
      return fsHandlers.write_file_content(args);
    },
  },
  setup: async () => {
    const { openFile } = await import("@/lib/open-file");
    await openFile(FILE);
  },
  actions: {
    selectLines,
    askLines: async () => {
      const why = await selectLines();
      if (why) return why;
      const view = await fileView();
      const { runScopeHandlers } = await import("@codemirror/view");
      const mac = /Mac/.test(navigator.platform);
      runScopeHandlers(
        view!,
        new KeyboardEvent("keydown", { key: "Enter", metaKey: mac, ctrlKey: !mac }),
        "editor",
      );
      return undefined;
    },
    openUnreadable: async () => {
      const { openFileAs } = await import("@/lib/open-file");
      openFileAs(`${MOCK_PROJECT.path}/assets/logo.psd`, "text");
    },
    failSaves: () => {
      savesFail = true;
    },
  },
};
