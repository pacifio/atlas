import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { dragPositionToCss } from "@/lib/drag-position";

/*
 * OS-level file drop onto a drop zone (Finder/Explorer → chat column, comms
 * conversation, canvas).
 *
 * Tauri v2 windows have `dragDropEnabled: true`, so the native webview handles
 * OS drag-drop and HTML5 `dataTransfer` drop events never fire — we subscribe
 * to Tauri's webview drag-drop event instead (the same mechanism the file-tree
 * external drop uses, see `useExternalFileDrop`).
 *
 * The listener is webview-global, so we scope each drop to THIS zone by
 * checking that the point lands inside `targetRef` — that keeps split-view
 * panes (and the file tree) from all reacting to the same drop.
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

    // Returns the CSS-px point when it lands inside the target, or null.
    const hitPoint = (position: { x: number; y: number }): { x: number; y: number } | null => {
      const el = targetRef.current;
      if (!el) return null;
      const p = dragPositionToCss(position);
      const hit = document.elementFromPoint(p.x, p.y);
      return hit && el.contains(hit) ? p : null;
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          const over = hitPoint(p.position) !== null;
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

/** The chat composer's drop zone, wired to `useComposerFileDrop`. */
export function useComposerDropZone({
  composerRef,
  disabled,
  attachPaths,
}: {
  composerRef: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  attachPaths: (paths: string[]) => Promise<void>;
}) {
  // Drag-and-drop from the OS. The zone is the whole conversation column
  // (`data-chat-drop-zone` in chat-panel.tsx), not this composer: a thin
  // target under a drag image that hangs off the cursor lit up and went dark
  // seemingly at random. Each split pane has its own column, so a drop still
  // lands in the pane under the cursor. Outside a chat panel, the composer.
  //
  // A drop is a pointing gesture — "this one, here, in the sentence I am
  // writing" — and `attachPaths` keeps that: the chip lands at the caret, and
  // an image's staged bytes ride along with it. The chip carries the
  // absolute path, which rides to the agent as an ACP `ResourceLink`
  // (`compose_prompt`) — every agent reads those.
  const dropZoneRef = useRef<HTMLElement | null>(null);
  const [dropZoneEl, setDropZoneEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const composer = composerRef.current;
    const zone = composer?.closest<HTMLElement>("[data-chat-drop-zone]") ?? composer ?? null;
    dropZoneRef.current = zone;
    setDropZoneEl(zone);
  }, []);
  const onDropFiles = useCallback((paths: string[]) => void attachPaths(paths), [attachPaths]);
  const { isDropTarget } = useComposerFileDrop({
    targetRef: dropZoneRef,
    enabled: !disabled,
    onDropFiles,
  });
  return { dropZoneEl, isDropTarget };
}
