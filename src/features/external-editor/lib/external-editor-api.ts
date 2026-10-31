// The two external-editor commands (`src-tauri/src/commands/external_editor.rs`).

import { invoke } from "@tauri-apps/api/core";

/** One installed editor. `id` is what `preferredEditor` stores. */
export interface ExternalEditor {
  id: string;
  label: string;
}

/** "The app the system opens this file with". Always in the detected list. */
export const SYSTEM_EDITOR_ID = "system";

/** A 1-based place in a file. */
export interface EditorPosition {
  line: number;
  column?: number;
}

/** The installed editors, in the order a default is picked from, ending with
 *  the system default. Rust caches the probe; `refresh` runs it again. */
export function detectExternalEditors(refresh = false): Promise<ExternalEditor[]> {
  return invoke<ExternalEditor[]>("external_editors_detect", { refresh });
}

/** Open `path` (a file or a folder) in `editor`, at `position` when the
 *  editor can take one. Rejects an id that detection did not find. */
export function openInExternalEditor(
  editor: string,
  path: string,
  position?: EditorPosition,
): Promise<void> {
  return invoke<void>("external_editor_open", {
    editor,
    path,
    line: position?.line ?? null,
    column: position?.column ?? null,
  });
}
