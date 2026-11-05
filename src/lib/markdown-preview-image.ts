/**
 * Images for the editor's markdown preview, as `data:` URLs from Rust.
 *
 * The webview cannot load them itself: the renderer CSP refuses remote
 * images, and a relative `src` resolves against the app's origin instead of
 * the document's folder. `markdown_preview_image` does both (see
 * `src-tauri/src/commands/markdown_preview.rs`).
 */

import { invoke } from "@tauri-apps/api/core";

const isRemote = (src: string) => /^https?:\/\//i.test(src.trim());

/** A remote image is the same bytes for every document; a local one is
 *  relative to the document, so the document is part of its identity. */
const keyFor = (docPath: string, src: string) => (isRemote(src) ? src : `${docPath}\0${src}`);

/** Last good URL per image — what a remounted `<img>` paints immediately
 *  rather than flashing empty while it asks again. */
const resolved = new Map<string, string>();
/** Remote fetches in flight or done, shared by every preview. Local files are
 *  re-read on each mount instead, so an edited screenshot shows up. */
const remote = new Map<string, Promise<string>>();

export function cachedPreviewImage(docPath: string, src: string): string | undefined {
  return resolved.get(keyFor(docPath, src));
}

export function previewImage(docPath: string, src: string): Promise<string> {
  const key = keyFor(docPath, src);
  const pending = remote.get(key);
  if (pending) return pending;
  const p = invoke<string>("markdown_preview_image", { docPath, src }).then(
    (url) => {
      resolved.set(key, url);
      return url;
    },
    (err: unknown) => {
      // Not cached: the next preview of this document gets to try again.
      remote.delete(key);
      throw err;
    },
  );
  if (isRemote(src)) remote.set(key, p);
  return p;
}
