import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { dragPositionToCss } from "@/lib/drag-position";
import { ROOT_DROP } from "./use-file-tree-drag-drop";

/* Receive OS-level file drops (Finder/Explorer → file tree) and copy
 * them in.
 *
 * Tauri v2 windows have `dragDropEnabled: true` by default, so the OS
 * drag-drop is handled by the native webview and HTML5 `dataTransfer`
 * drop events never fire. We subscribe to Tauri's webview drag-drop
 * event instead. Its `position` unit differs per platform despite the
 * `PhysicalPosition` type; `dragPositionToCss` owns that conversion.
 *
 * `dropPath` (a real directory path, the `ROOT_DROP` sentinel, or null)
 * is returned for highlighting and is folded into the same drop-target
 * styling the internal pointer-drag uses. The drop itself is delegated
 * to `onDropFiles(paths, destDir)`.
 */

const dirOfPath = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
};

export function useExternalFileDrop(opts: {
  rootPath: string | null;
  onDropFiles: (paths: string[], destDir: string) => void;
  /** This tree's own container: a drop over another tree is not ours. */
  scopeRef?: React.RefObject<HTMLElement | null>;
}) {
  const { rootPath, onDropFiles, scopeRef } = opts;
  const [dropPath, setDropPath] = useState<string | null>(null);

  useEffect(() => {
    if (!rootPath) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    // Map a physical-pixel position to the destination directory under
    // the cursor: a folder row → that folder; a file row → its parent;
    // the empty tree area → root. Returns null when not over the tree.
    const resolveDir = (position: { x: number; y: number }): string | null => {
      const p = dragPositionToCss(position);
      const el = document.elementFromPoint(p.x, p.y);
      if (!el) return null;
      const scope = scopeRef?.current;
      if (scope && !scope.contains(el)) return null;
      // A folder name inside a compacted row is a drop target of its own.
      const segment = el.closest<HTMLElement>("[data-tree-drop-path]");
      const rowEl = segment ?? el.closest<HTMLElement>("[data-tree-path]");
      if (rowEl) {
        const path = rowEl.getAttribute(segment ? "data-tree-drop-path" : "data-tree-path");
        if (!path) return null;
        const isDir = !!segment || rowEl.getAttribute("data-tree-is-dir") === "true";
        if (isDir) return path;
        const parent = dirOfPath(path);
        return parent === rootPath ? ROOT_DROP : parent;
      }
      if (el.closest("[data-tree-root]")) return ROOT_DROP;
      return null;
    };

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          const dir = resolveDir(p.position);
          setDropPath((prev) => (prev === dir ? prev : dir));
        } else if (p.type === "leave") {
          setDropPath(null);
        } else if (p.type === "drop") {
          const dir = resolveDir(p.position);
          setDropPath(null);
          if (dir && p.paths.length > 0) {
            const destDir = dir === ROOT_DROP ? rootPath : dir;
            onDropFiles(p.paths, destDir);
          }
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      unlisten?.();
      setDropPath(null);
    };
  }, [rootPath, onDropFiles, scopeRef]);

  return { externalDropPath: dropPath };
}
