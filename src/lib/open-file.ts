/**
 * Single entry point for "open this file as a tab". Classifies the file by
 * extension and routes to the editor, media viewer, or unsupported view —
 * use this anywhere a file path needs to become a tab (Cmd+P palette,
 * explorer tree click, drag-and-drop, etc.) so the routing logic stays in
 * one place.
 */

import { invoke } from "@tauri-apps/api/core";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { classifyFile, type FileKind } from "@/lib/file-types";

/** Resolve the file kind, sniffing the bytes for unrecognized extensions:
 *  extension classification is an allowlist, so unknown names fall to
 *  "unsupported" — but if the bytes are UTF-8/ASCII text we treat it as text. */
export async function resolveFileKind(path: string): Promise<FileKind> {
  let kind = classifyFile(path);
  if (kind === "unsupported") {
    try {
      if (await invoke<boolean>("is_text_file", { path })) kind = "text";
    } catch {
      /* keep "unsupported" if the sniff fails */
    }
  }
  return kind;
}

function openWithKind(path: string, kind: FileKind): void {
  const tabType = tabTypeFor(kind);
  const title = path.split("/").pop() ?? path;
  // `id` is stable per path + tabType so reopening the same file restores
  // its existing tab instead of stacking duplicates.
  const id = `${tabType}:${path}`;
  useLayoutStore.getState().actions.addTab({
    id,
    type: tabType,
    title,
    closable: true,
    dirty: false,
    data: { filePath: path, fileKind: kind },
  });
}

export async function openFile(path: string): Promise<void> {
  openWithKind(path, await resolveFileKind(path));
}

/** Open a file in Atlas when it's a kind Atlas can render; otherwise reveal it
 *  in the OS file manager (Finder on macOS). Used by terminal link clicks — the
 *  user wants compatible files in-app and everything else handed to the OS. */
export async function openFileOrReveal(path: string): Promise<void> {
  const kind = await resolveFileKind(path);
  if (kind === "unsupported") {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch {
      /* nothing more we can do */
    }
    return;
  }
  openWithKind(path, kind);
}

function tabTypeFor(
  kind: FileKind,
): "editor" | "media" | "svg" | "pdf" | "unsupported" {
  if (kind === "text") return "editor";
  if (kind === "image" || kind === "video" || kind === "audio") return "media";
  if (kind === "svg") return "svg";
  if (kind === "pdf") return "pdf";
  return "unsupported";
}
