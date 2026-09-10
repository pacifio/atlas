import { invoke } from "@tauri-apps/api/core";

/*
 * Pasted bytes → a path the upload pipelines already understand.
 *
 * Every upload in Atlas (team-chat attachments, Space media) takes an absolute
 * file path — that is what OS drag-drop and the file picker provide. A pasted
 * screenshot is the one input that arrives as bytes: the WKWebView `paste`
 * event exposes a nameless `File` with no path. `scratchPathForFile` spools it
 * through Rust (`scratch_write_bytes`, raw IPC body — no base64 JSON) into the
 * app cache and hands back a path, so neither pipeline learns a second shape.
 */

/** A default name when the clipboard gives none — `image.png` is what WebKit
 *  calls a pasted screenshot; keep the extension so the mime guess lands. */
function nameFor(file: File): string {
  if (file.name && file.name !== "image.png") return file.name;
  const ext = file.type.split("/")[1]?.split("+")[0] || "png";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `pasted-${stamp}.${ext === "jpeg" ? "jpg" : ext}`;
}

/** Write `file` to the app's scratch dir and return its absolute path. */
export async function scratchPathForFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  return invoke<string>("scratch_write_bytes", new Uint8Array(buf), {
    headers: { "x-filename": encodeURIComponent(nameFor(file)) },
  });
}

/**
 * The files carried by a paste or drop, if any.
 *
 * `items` is read first — a pasted screenshot arrives as a `kind === "file"`
 * item with no entry in `files` on some WebKit builds — then `files` as the
 * fallback. Finder-copied files show up here as zero-byte stubs with a name
 * but no bytes; those are excluded so the caller can go through the native
 * pasteboard (`clipboard_file_paths`) instead.
 */
export function filesFromClipboard(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  const seen = new Set<File>();
  const push = (f: File | null) => {
    if (!f || seen.has(f) || f.size === 0) return;
    seen.add(f);
    out.push(f);
  };
  if (dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file") push(item.getAsFile());
    }
  }
  if (out.length === 0 && dt.files) {
    for (const f of Array.from(dt.files)) push(f);
  }
  return out;
}

/** Whether the clipboard/drop carries file references at all (including the
 *  path-less Finder stubs `filesFromClipboard` excludes). */
export function hasFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  return Array.from(dt.types).includes("Files") || (dt.files?.length ?? 0) > 0;
}
