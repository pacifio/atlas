import { invoke } from "@tauri-apps/api/core";
import type { KeybindingsFile } from "./types";

/** Thin IPC wrapper over `src-tauri/src/commands/keybindings.rs`. Components
 *  never call these directly — the store owns every write. */

export interface KeybindingsLoadResult {
  file: KeybindingsFile;
  path: string;
  warnings: string[];
}

export function loadKeybindings(): Promise<KeybindingsLoadResult> {
  return invoke<KeybindingsLoadResult>("keybindings_load");
}

export function saveKeybindings(file: KeybindingsFile): Promise<KeybindingsFile> {
  return invoke<KeybindingsFile>("keybindings_save", { file });
}

export function openKeybindingsFile(): Promise<void> {
  return invoke("keybindings_open");
}
