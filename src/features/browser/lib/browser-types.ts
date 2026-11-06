/** The Browser tab's IPC shapes, apart from `browser-api.ts` so views can
 *  name them without importing the IPC wrapper. */

export interface ReadableContent {
  title: string;
  url: string;
  html: string;
}

// Rust-owned navigation state for the embedded webview, pushed over the
// `atlas:browser-nav` event. The native child webview is the source of truth.
export interface BrowserNav {
  id: string;
  url: string;
  loading: boolean;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** Window-relative rect the native child webview is positioned to. */
export interface EmbedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserMode = "live" | "reader";
