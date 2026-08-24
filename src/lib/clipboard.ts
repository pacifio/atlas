/**
 * Copying text, including from places the web clipboard API refuses.
 *
 * `navigator.clipboard.writeText` needs a live user activation. WKWebView drops
 * that activation across an `await`, so a copy that follows a network
 * round-trip — inviting a teammate and copying the links the server just minted
 * — throws `NotAllowedError` however the promise is chained. The native
 * pasteboard has no such rule, so Rust is the fallback.
 *
 * The web API is still tried first: it needs no IPC, and it is the path that
 * works everywhere for the ordinary in-gesture copy.
 */

import { invoke } from "@tauri-apps/api/core";

/** Put `text` on the clipboard. Resolves `true` when it landed.
 *
 * NATIVE FIRST, web API as the fallback — the reverse of the original order.
 * WKWebView's `navigator.clipboard.writeText` can RESOLVE without actually
 * writing (permission/pasteboard quirks), and a lying success meant the Rust
 * fallback never ran — the git-error dialog's "Copy output" silently copied
 * nothing. The native pasteboard has no activation rules and no silent-failure
 * mode; the web API only matters where IPC isn't available. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await invoke("clipboard_write_text", { text });
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}
