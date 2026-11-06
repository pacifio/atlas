import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BrowserNav, EmbedRect, ReadableContent } from "./browser-types";

/**
 * The Browser tab's IPC surface: the embedded native child webview
 * (`browser_embed_*`), the separate browser window, the Reader fetch, and the
 * one knowledge write the Reader's "Save to knowledge" makes. Thin wrappers,
 * per the repo's `lib/<domain>-api.ts` convention — command names and payload
 * fields are the Rust handlers' own, and every wrapper returns the `invoke`
 * promise untouched so callers keep their own `.catch` handling.
 */

export type { BrowserNav, EmbedRect, ReadableContent } from "./browser-types";

export function browserEmbedCreate(id: string, url: string, rect: EmbedRect): Promise<unknown> {
  return invoke("browser_embed_create", { id, url, rect });
}

export function browserEmbedNavigate(id: string, url: string): Promise<unknown> {
  return invoke("browser_embed_navigate", { id, url });
}

export function browserEmbedSetBounds(id: string, rect: EmbedRect): Promise<unknown> {
  return invoke("browser_embed_set_bounds", { id, rect });
}

export function browserEmbedSetVisible(id: string, visible: boolean): Promise<unknown> {
  return invoke("browser_embed_set_visible", { id, visible });
}

export function browserEmbedBack(id: string): Promise<unknown> {
  return invoke("browser_embed_back", { id });
}

export function browserEmbedForward(id: string): Promise<unknown> {
  return invoke("browser_embed_forward", { id });
}

export function browserEmbedReload(id: string): Promise<unknown> {
  return invoke("browser_embed_reload", { id });
}

export function browserEmbedDestroy(id: string): Promise<unknown> {
  return invoke("browser_embed_destroy", { id });
}

/** Opens `url` in a separate native WebKit browser window. */
export function browserOpenWindow(url: string): Promise<unknown> {
  return invoke("browser_open_window", { url });
}

/** Reader mode's sanitized, JS-free fetch of a page. */
export function fetchReadable(url: string): Promise<ReadableContent> {
  return invoke<ReadableContent>("fetch_readable", { url });
}

/** Writes one note into the project's knowledge base. */
export function saveKnowledgeNote(
  projectPath: string,
  id: string,
  content: string,
): Promise<unknown> {
  return invoke("save_knowledge_note", { projectPath, id, content });
}

/** Subscribes to Rust's navigation deltas for every embed; filter by `id`. */
export function listenBrowserNav(onNav: (nav: BrowserNav) => void): Promise<UnlistenFn> {
  return listen<BrowserNav>("atlas:browser-nav", (e) => onNav(e.payload));
}
