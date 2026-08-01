import { useCallback, useEffect, useRef, useState } from "react";

/* Pointer-event drag-and-drop for the file tree.
 *
 * We deliberately avoid the native HTML5 drag API. The tree is
 * virtualized (@tanstack/react-virtual) so every row is absolutely
 * positioned via `transform: translateY(...)`. With no explicit
 * `setDragImage()`, the browser auto-snapshots a DOM node for the drag
 * preview and — with absolutely-positioned rows — grabs the topmost
 * element instead of the grabbed row, so the preview showed the wrong
 * filename. Native DnD also forced a pile of WKWebView "protected mode"
 * dataTransfer workarounds.
 *
 * Instead we track mousedown → mousemove → mouseup ourselves (Zed/Athas
 * style): a 5px movement threshold starts the drag, a custom floating
 * label follows the cursor, and `document.elementFromPoint` + the row's
 * `data-tree-path` / `data-tree-is-dir` attributes resolve the hovered
 * destination. `dragOverPath` is always a real directory path (or the
 * sentinel `"__ROOT__"`) so the destination folder row can highlight
 * itself unambiguously.
 */

const DRAG_THRESHOLD = 5;
const AUTO_EXPAND_MS = 550;

/** Sentinel for "drop into the project root". */
export const ROOT_DROP = "__ROOT__";

interface DraggedItem {
  path: string;
  name: string;
  isDir: boolean;
}

export interface FileTreeDragState {
  isDragging: boolean;
  draggedItem: DraggedItem | null;
  /** Resolved destination directory path, or `ROOT_DROP`, or null. */
  dragOverPath: string | null;
}

const INITIAL: FileTreeDragState = {
  isDragging: false,
  draggedItem: null,
  dragOverPath: null,
};

const dirOfPath = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
};

export function useFileTreeDragDrop(opts: {
  rootPath: string | null;
  onMove: (src: string, destDir: string) => void;
  onAutoExpand: (path: string) => void;
}) {
  const [dragState, setDragState] = useState<FileTreeDragState>(INITIAL);

  // Stable mirrors of inputs + live state so the global mouse listeners
  // (installed once per drag) never read stale closures.
  const rootRef = useRef(opts.rootPath);
  rootRef.current = opts.rootPath;
  const onMoveRef = useRef(opts.onMove);
  onMoveRef.current = opts.onMove;
  const onAutoExpandRef = useRef(opts.onAutoExpand);
  onAutoExpandRef.current = opts.onAutoExpand;

  const itemRef = useRef<DraggedItem | null>(null);
  const overRef = useRef<string | null>(null);
  const draggingRef = useRef(false);
  const pendingRef = useRef<{ x: number; y: number; item: DraggedItem } | null>(
    null,
  );
  const previewRef = useRef<HTMLDivElement | null>(null);
  const autoExpandRef = useRef<{ path: string; timeoutId: number } | null>(
    null,
  );
  const detachRef = useRef<(() => void) | null>(null);

  const clearAutoExpand = useCallback(() => {
    if (!autoExpandRef.current) return;
    window.clearTimeout(autoExpandRef.current.timeoutId);
    autoExpandRef.current = null;
  }, []);

  const scheduleAutoExpand = useCallback(
    (path: string) => {
      if (autoExpandRef.current?.path === path) return;
      clearAutoExpand();
      autoExpandRef.current = {
        path,
        timeoutId: window.setTimeout(() => {
          onAutoExpandRef.current(path);
          autoExpandRef.current = null;
        }, AUTO_EXPAND_MS),
      };
    },
    [clearAutoExpand],
  );

  const positionPreview = useCallback((x: number, y: number) => {
    const el = previewRef.current;
    if (el) {
      el.style.left = `${x + 12}px`;
      el.style.top = `${y - 8}px`;
    }
  }, []);

  const teardown = useCallback(() => {
    pendingRef.current = null;
    itemRef.current = null;
    overRef.current = null;
    draggingRef.current = false;
    clearAutoExpand();
    if (previewRef.current) {
      previewRef.current.remove();
      previewRef.current = null;
    }
    detachRef.current?.();
    detachRef.current = null;
    setDragState(INITIAL);
  }, [clearAutoExpand]);

  // Resolve the destination directory under the cursor. Returns a real
  // directory path, the ROOT_DROP sentinel, or null (no valid target).
  const resolveTarget = useCallback(
    (x: number, y: number, dragged: DraggedItem) => {
      const el = document.elementFromPoint(x, y);
      const rowEl = el?.closest<HTMLElement>("[data-tree-path]");
      if (rowEl) {
        const path = rowEl.getAttribute("data-tree-path");
        if (!path) return null;
        const isDir = rowEl.getAttribute("data-tree-is-dir") === "true";
        // Refuse dropping a folder onto itself or a descendant.
        if (
          path === dragged.path ||
          (dragged.isDir && path.startsWith(dragged.path + "/"))
        ) {
          return null;
        }
        if (isDir) {
          scheduleAutoExpand(path);
          return path;
        }
        // Over a file → target its parent directory.
        clearAutoExpand();
        const parent = dirOfPath(path);
        return parent === rootRef.current ? ROOT_DROP : parent;
      }
      if (el?.closest("[data-tree-root]")) {
        clearAutoExpand();
        return ROOT_DROP;
      }
      clearAutoExpand();
      return null;
    },
    [scheduleAutoExpand, clearAutoExpand],
  );

  const beginDrag = useCallback(
    (x: number, y: number, item: DraggedItem) => {
      draggingRef.current = true;
      itemRef.current = item;

      const preview = document.createElement("div");
      preview.textContent = item.name;
      preview.style.cssText = [
        "position:fixed",
        "pointer-events:none",
        "z-index:9999",
        "padding:3px 9px",
        "border-radius:6px",
        "font-size:12px",
        "font-family:var(--font-mono,monospace)",
        "line-height:1.4",
        "white-space:nowrap",
        "color:var(--text-secondary)",
        "background:var(--bg-elevated)",
        "border:1px solid var(--border-default)",
        "box-shadow:0 4px 14px rgba(0,0,0,0.3)",
        "backdrop-filter:blur(12px)",
      ].join(";");
      document.body.appendChild(preview);
      previewRef.current = preview;
      document.body.style.cursor = "grabbing";
      positionPreview(x, y);

      setDragState({ isDragging: true, draggedItem: item, dragOverPath: null });
    },
    [positionPreview],
  );

  const onContainerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Don't hijack the inline rename/new-entry input.
      if (target.closest("input")) return;
      const rowEl = target.closest<HTMLElement>("[data-tree-path]");
      if (!rowEl) return;
      const path = rowEl.getAttribute("data-tree-path");
      if (!path) return;
      const isDir = rowEl.getAttribute("data-tree-is-dir") === "true";
      const name = path.slice(path.lastIndexOf("/") + 1);
      pendingRef.current = {
        x: e.clientX,
        y: e.clientY,
        item: { path, name, isDir },
      };

      const onMouseMove = (ev: MouseEvent) => {
        const pending = pendingRef.current;
        if (pending && !draggingRef.current) {
          if (
            Math.hypot(ev.clientX - pending.x, ev.clientY - pending.y) >
            DRAG_THRESHOLD
          ) {
            beginDrag(ev.clientX, ev.clientY, pending.item);
          }
          return;
        }
        if (!draggingRef.current || !itemRef.current) return;
        ev.preventDefault(); // suppress text selection mid-drag
        positionPreview(ev.clientX, ev.clientY);
        const next = resolveTarget(ev.clientX, ev.clientY, itemRef.current);
        if (next !== overRef.current) {
          overRef.current = next;
          setDragState((prev) => ({ ...prev, dragOverPath: next }));
        }
      };

      const onMouseUp = () => {
        const wasDragging = draggingRef.current;
        const item = itemRef.current;
        const over = overRef.current;
        if (wasDragging && item && over) {
          const destDir = over === ROOT_DROP ? rootRef.current : over;
          if (destDir) onMoveRef.current(item.path, destDir);
        }
        if (wasDragging) {
          // Swallow the click that fires right after a drag-drop so it
          // doesn't open the file / toggle the folder under the cursor.
          // The synthetic click (if any) fires synchronously after this
          // mouseup, so a 0ms timeout removes the guard when no click
          // comes — otherwise it would linger and eat the next click.
          const suppress = (ce: MouseEvent) => {
            ce.stopPropagation();
            ce.preventDefault();
          };
          window.addEventListener("click", suppress, {
            capture: true,
            once: true,
          });
          window.setTimeout(() => {
            window.removeEventListener("click", suppress, { capture: true });
          }, 0);
        }
        document.body.style.cursor = "";
        teardown();
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      detachRef.current = () => {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };
    },
    [beginDrag, positionPreview, resolveTarget, teardown],
  );

  // Safety net: tear everything down if the component unmounts mid-drag.
  useEffect(() => teardown, [teardown]);

  return { dragState, onContainerMouseDown };
}
