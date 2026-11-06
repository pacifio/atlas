// "Open in <editor>": the installed editors, `external_editors_detect`, and
// opening a path in one, `external_editor_open`. A plausible Mac with a few
// editors, so the menus show a preferred one and an "Open With" list. A
// browser has no editor to hand the path to, so opening answers with a toast
// saying what Atlas would have done, rather than silently.

import { toast } from "sonner";
import type { ExternalEditor } from "@/features/external-editor/lib/external-editor-api";
import type { TypedHandlers, Unit } from "../types";

const EDITORS: ExternalEditor[] = [
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "zed", label: "Zed" },
  { id: "idea", label: "IntelliJ IDEA" },
  { id: "xcode", label: "Xcode" },
  { id: "system", label: "System default" },
];

export interface ExternalEditorResponses {
  external_editors_detect: ExternalEditor[];
  external_editor_open: Unit;
}

export const externalEditorHandlers: TypedHandlers<ExternalEditorResponses> = {
  external_editors_detect: () => EDITORS,
  external_editor_open: ({ editor, path, line, column }) => {
    const known = EDITORS.find((e) => e.id === editor);
    if (!known) throw new Error(`Unknown editor: ${String(editor)}`);
    const at = line ? `:${line}${column ? `:${column}` : ""}` : "";
    toast(`Would open in ${known.label}`, { description: `${String(path)}${at}` });
    return null;
  },
};
