/**
 * Single entry point for "open this file as a tab". Classifies the file by
 * extension and routes to the editor, media viewer, or unsupported view —
 * use this anywhere a file path needs to become a tab (Cmd+P palette,
 * explorer tree click, drag-and-drop, etc.) so the routing logic stays in
 * one place.
 */

import { invoke } from "@tauri-apps/api/core";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useEditorStore } from "@/features/editor/stores/editor-store";
import type { RevealTarget } from "@/features/editor/lib/reveal";
import { classifyFile, type FileKind } from "@/lib/file-types";

export type { RevealTarget };

export interface OpenFileOptions {
  /** Where to put the cursor once the file is open. Editor tabs only; other
   *  kinds of file ignore it. */
  reveal?: RevealTarget;
}

/** The one tab id a text file opens under. Every opener must use it, or the
 *  same file ends up in two tabs and a reveal lands in the wrong one. */
export function editorTabId(path: string): string {
  return `editor:${path}`;
}

/** Resolve the file kind, sniffing the bytes for unrecognized extensions:
 *  extension classification is an allowlist, so unknown names fall to
 *  "unsupported" — but if the bytes are UTF-8/ASCII text we treat it as text. */
export async function fileKindOf(path: string): Promise<FileKind> {
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

/** Open `path` as a tab of the kind `kind` renders in, synchronously, and
 *  return the tab id. For a caller that already knows the kind (a file it has
 *  just written as text, say); everything else should use {@link openFile}. */
export function openFileAs(path: string, kind: FileKind, opts?: OpenFileOptions): string {
  const tabType = tabTypeFor(kind);
  const title = path.split("/").pop() ?? path;
  // `id` is stable per path + tabType so reopening the same file restores
  // its existing tab instead of stacking duplicates.
  const id = tabType === "editor" ? editorTabId(path) : `${tabType}:${path}`;
  // Before the tab exists, so a panel that mounts on this very call finds it.
  if (opts?.reveal && tabType === "editor") {
    useEditorStore.getState().actions.requestReveal(path, opts.reveal);
  }
  useLayoutStore.getState().actions.addTab({
    id,
    type: tabType,
    title,
    closable: true,
    dirty: false,
    data: { filePath: path, fileKind: kind },
  });
  return id;
}

/** Open `path` as a tab, classified by extension (or by sniffing the bytes),
 *  and resolve to the tab id. */
export async function openFile(path: string, opts?: OpenFileOptions): Promise<string> {
  return openFileAs(path, await fileKindOf(path), opts);
}

/** Open a file in Atlas when it's a kind Atlas can render; otherwise reveal it
 *  in the OS file manager (Finder on macOS). Used by terminal link clicks — the
 *  user wants compatible files in-app and everything else handed to the OS. */
export async function openFileOrReveal(path: string): Promise<void> {
  const kind = await fileKindOf(path);
  if (kind === "unsupported") {
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(path);
    } catch {
      /* nothing more we can do */
    }
    return;
  }
  openFileAs(path, kind);
}

function tabTypeFor(
  kind: FileKind,
): "editor" | "media" | "svg" | "pdf" | "notebook" | "unsupported" {
  if (kind === "text") return "editor";
  if (kind === "image" || kind === "video" || kind === "audio") return "media";
  if (kind === "svg") return "svg";
  if (kind === "pdf") return "pdf";
  if (kind === "notebook") return "notebook";
  return "unsupported";
}
