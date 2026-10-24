// The workspace row's verbs: where the project lives, opened somewhere else.
//
// Opening it in an editor is `external-editor`'s; these are the rest: Finder,
// a terminal, the path.

import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

/** Show the project folder in Finder (Explorer / the file manager elsewhere). */
export async function revealProject(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    toast.error(`Could not reveal ${path}`, { description: String(e) });
  }
}

/** Open the system terminal at the project root (`fs_open_in_terminal`). */
export async function openProjectInTerminal(path: string): Promise<void> {
  try {
    await invoke("fs_open_in_terminal", { path });
  } catch (e) {
    toast.error("Could not open a terminal", { description: String(e) });
  }
}

export async function copyProjectPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    toast.success("Path copied");
  } catch {
    toast.error("Could not copy the path");
  }
}
