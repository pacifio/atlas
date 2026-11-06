/**
 * The interface zoom (⌘+/⌘-), as `applyUiScale` publishes it in `--ui-zoom`.
 * It is the native WebView zoom, so anything that measures in window points
 * or sizes a backing store by hand has to account for it: CSS px are not
 * points once the page is zoomed.
 */
export function uiZoom(): number {
  if (typeof document === "undefined") return 1;
  const value = Number.parseFloat(document.documentElement.style.getPropertyValue("--ui-zoom"));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * A canvas renderer's backing-store resolution: at least 2 (sharp on a
 * Retina screen, as before), scaled with the interface zoom so a zoomed-in
 * graph is not upsampled, and capped at 3 to bound the fill cost. Whether a
 * webview folds its zoom into `devicePixelRatio` differs by engine; taking
 * the larger of the two covers both without counting the zoom twice.
 */
export function canvasResolution(): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(3, Math.max(2, dpr, 2 * uiZoom()));
}
