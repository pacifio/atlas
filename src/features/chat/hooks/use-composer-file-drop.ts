import { useEffect, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

/*
 * OS-level file drop onto the chat composer (Finder/Explorer → composer →
 * attached as mention chips).
 *
 * Tauri v2 windows have `dragDropEnabled: true`, so the native webview handles
 * OS drag-drop and HTML5 `dataTransfer` drop events never fire — we subscribe
 * to Tauri's webview drag-drop event instead (the same mechanism the file-tree
 * external drop uses, see `useExternalFileDrop`). The event `position` is in
 * PHYSICAL pixels, so we hit-test with the raw coords first and fall back to
 * coords ÷ devicePixelRatio (Retina).
 *
 * The listener is webview-global, so we scope each drop to THIS composer by
 * checking that the point lands inside `targetRef` — that keeps split-view
 * composers (and the file tree) from all reacting to the same drop.
 */
export function useComposerFileDrop(opts: {
  targetRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  /** `at` is the drop point in CSS px (viewport coords), when it could be
   *  resolved — a canvas uses it to place what was dropped. */
  onDropFiles: (paths: string[], at?: { x: number; y: number }) => void;
}) {
  const { targetRef, enabled = true, onDropFiles } = opts;
  const [isDropTarget, setIsDropTarget] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    // Returns the CSS-px point that landed inside the target, or null.
    const hitPoint = (position: { x: number; y: number }): { x: number; y: number } | null => {
      const el = targetRef.current;
      if (!el) return null;
      const dpr = window.devicePixelRatio || 1;
      const pts = [
        { x: position.x, y: position.y },
        { x: position.x / dpr, y: position.y / dpr },
      ];
      for (const p of pts) {
        const hit = document.elementFromPoint(p.x, p.y);
        if (hit && el.contains(hit)) return p;
      }
      return null;
    };
    const isOver = (position: { x: number; y: number }): boolean => hitPoint(position) !== null;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          const over = isOver(p.position);
          setIsDropTarget((prev) => (prev === over ? prev : over));
        } else if (p.type === "leave") {
          setIsDropTarget(false);
        } else if (p.type === "drop") {
          const at = hitPoint(p.position);
          setIsDropTarget(false);
          if (at && p.paths.length > 0) onDropFiles(p.paths, at);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      unlisten?.();
      setIsDropTarget(false);
    };
  }, [enabled, onDropFiles, targetRef]);

  return { isDropTarget };
}
