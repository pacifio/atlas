//! Global interface zoom (⌘+ / ⌘- / ⌘0).
//!
//! Uses the native WebView zoom — the same thing browser ⌘±/⌘0 drives — so it
//! scales the ENTIRE UI (text + layout), not just `rem`-based sizes. Root
//! font-size scaling wouldn't work because the app uses px-based utilities
//! (`text-xs`, `h-[32px]`) everywhere.
//!
//! The factor is persisted as `uiScale` in `config.toml` and re-applied on
//! boot by the settings store's `hydrate`.

import { getCurrentWebview } from "@tauri-apps/api/webview";

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 2.0;
export const SCALE_STEP = 0.1;
export const DEFAULT_SCALE = 1;

/** The named steps the interface-scale popover offers. The stepper and the
 *  zoom shortcuts still move on the `SCALE_STEP` grid; a preset is just a
 *  shortcut to a size worth naming. */
export const SCALE_PRESETS = [
  { value: 0.9, label: "Compact" },
  { value: 1, label: "Default" },
  { value: 1.15, label: "Large" },
  { value: 1.3, label: "Larger" },
] as const;

/** Round to a clean grid and clamp into [MIN_SCALE, MAX_SCALE]. */
export function clampScale(scale: number): number {
  const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  // Avoid float drift (0.1 + 0.2 …) accumulating across repeated ⌘+ presses.
  return Math.round(clamped * 100) / 100;
}

/** Apply the interface zoom via the native WebView. */
export function applyUiScale(scale: number): void {
  // The window bar reads this to stay a constant height on screen: the macOS
  // traffic lights it centres are drawn by the OS and never zoom.
  document.documentElement.style.setProperty("--ui-zoom", String(clampScale(scale)));
  void getCurrentWebview()
    .setZoom(clampScale(scale))
    .catch((e) => console.warn("setZoom failed:", e));
}
