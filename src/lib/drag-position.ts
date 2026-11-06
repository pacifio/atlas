import { isWindows } from "@/lib/platform";
import { uiZoom } from "@/lib/ui-zoom";

/**
 * The drag position in CSS px. Tauri types it `PhysicalPosition`, but the unit
 * is whatever wry's platform backend produced (wry 0.55):
 *  - macOS: `draggingLocation`, in points — CSS px only at 100% zoom.
 *  - Linux: GTK `drag-motion` x/y, in logical px — likewise.
 *  - Windows: `ScreenToClient`, in device pixels — divide by the scale.
 * The interface zoom is the WebView's own, so on macOS and Linux a point is
 * `zoom` CSS px wide; on Windows WebView2 folds it into `devicePixelRatio`.
 * Don't "try raw, then scaled": on a scaled Windows display the raw point
 * usually lands on some other real element first, and the wrong zone lights up.
 */
export function dragPositionToCss(position: { x: number; y: number }): { x: number; y: number } {
  const scale = isWindows ? window.devicePixelRatio || 1 : uiZoom();
  return { x: position.x / scale, y: position.y / scale };
}
