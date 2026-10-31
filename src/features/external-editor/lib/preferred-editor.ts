// Which editor "Open in <editor>" means, and opening a path in it.
//
// `preferredEditor` holds an editor id, "system", or "" for "the first editor
// detected". The detected list is in preference order and always ends with
// the system default, so "" resolves to the first real editor when there is
// one. A saved id that is no longer installed resolves the same way.

import { toast } from "sonner";
import { useEffect } from "react";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { useExternalEditorStore } from "../stores/external-editor-store";
import {
  openInExternalEditor,
  SYSTEM_EDITOR_ID,
  type EditorPosition,
  type ExternalEditor,
} from "./external-editor-api";

/** The editor `setting` names, else the first detected; null before the
 *  list has loaded (or if it came back empty). */
export function resolvePreferredEditor(
  setting: string,
  editors: readonly ExternalEditor[] | null,
): ExternalEditor | null {
  if (!editors || editors.length === 0) return null;
  return editors.find((e) => e.id === setting) ?? editors[0] ?? null;
}

/** The editor a file outside the project opens in: only one the user picked
 *  by name. Otherwise (automatic, or "system") it goes to the system's app,
 *  as it always has. */
export function editorForOutsideFiles(
  setting: string,
  editors: readonly ExternalEditor[] | null,
): ExternalEditor | null {
  if (!setting || setting === SYSTEM_EDITOR_ID) return null;
  return editors?.find((e) => e.id === setting) ?? null;
}

/** How a menu names `editor`: its label, or "Default App" for the system's. */
export function editorName(editor: ExternalEditor | null): string {
  if (!editor) return "Editor";
  return editor.id === SYSTEM_EDITOR_ID ? "Default App" : editor.label;
}

/** "Open in Cursor"; the system default reads "Open in Default App". */
export function openInLabel(editor: ExternalEditor | null): string {
  return `Open in ${editorName(editor)}`;
}

/** The detected editors, loading them on first use, and the preferred one. */
export function usePreferredEditor(): {
  editors: ExternalEditor[] | null;
  preferred: ExternalEditor | null;
} {
  const editors = useExternalEditorStore.use.editors();
  const setting = useSettingsStore((s) => s.settings.preferredEditor);
  useEffect(() => {
    if (!editors) void useExternalEditorStore.getState().actions.load();
  }, [editors]);
  return { editors, preferred: resolvePreferredEditor(setting, editors) };
}

/** Open `path` in the editor `editorId`, reporting a failure as a toast. */
export async function openInEditor(
  editorId: string,
  path: string,
  position?: EditorPosition,
): Promise<void> {
  try {
    await openInExternalEditor(editorId, path, position);
  } catch (e) {
    const editors = useExternalEditorStore.getState().editors;
    const label = editors?.find((x) => x.id === editorId)?.label ?? "your editor";
    toast.error(`Couldn't open in ${label}`, { description: String(e) });
  }
}

/** Open `path` in the preferred editor (see the header). */
export async function openInPreferredEditor(
  path: string,
  position?: EditorPosition,
): Promise<void> {
  const editors = await useExternalEditorStore.getState().actions.load();
  const setting = useSettingsStore.getState().settings.preferredEditor;
  const editor = resolvePreferredEditor(setting, editors);
  await openInEditor(editor?.id ?? SYSTEM_EDITOR_ID, path, position);
}

/** A file Atlas has nowhere to place (outside the project): the editor the
 *  user picked by name, else the system's app for that file type. */
export async function openOutsideFile(path: string): Promise<void> {
  const editors = await useExternalEditorStore.getState().actions.load();
  const setting = useSettingsStore.getState().settings.preferredEditor;
  const editor = editorForOutsideFiles(setting, editors);
  await openInEditor(editor?.id ?? SYSTEM_EDITOR_ID, path);
}
