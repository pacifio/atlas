// Host OS, sniffed once from the webview's user agent. Atlas ships no
// `@tauri-apps/plugin-os` (see the plugin selection in src-tauri/Cargo.toml),
// and the UA is exact enough for what this answers: which window chrome and
// platform conventions to render. WKWebView reports "Macintosh", WebView2
// "Windows NT", WebKitGTK on Linux reports "Linux".

const ua: string = typeof navigator !== "undefined" ? navigator.userAgent : "";

export const isMac: boolean = ua.includes("Macintosh");
export const isWindows: boolean = ua.includes("Windows");
export const isLinux: boolean = ua.includes("Linux");

/** The platform as a stylesheet hook: `html.platform-linux` and so on.
 *
 *  `main.tsx` sets it before the first render. The one consumer is the Linux
 *  block at the end of `globals.css`, which steps long-running animations:
 *  WebKitGTK presents a full-window frame for every tick of one, and a 14 px
 *  spinner measured 40% of a core. A class rather than a data attribute:
 *  `@shadcn/lint` learns the stylesheet's plain classes by parsing it, and an
 *  attribute selector in a rule stops that parse, losing every class after it. */
export function markPlatform(root: HTMLElement = document.documentElement): void {
  const name = isMac ? "macos" : isWindows ? "windows" : isLinux ? "linux" : "unknown";
  root.classList.add(`platform-${name}`);
}
