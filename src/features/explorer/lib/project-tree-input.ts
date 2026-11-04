import type { Dispatch, KeyboardEvent, MouseEvent, RefObject, SetStateAction } from "react";

import { absoluteOf, type ProjectFileOps } from "./project-file-ops";
import { parentOf, type TreeRowData } from "./project-tree-model";
import { ROW_HEIGHT } from "./tree-constants";

export interface Selection {
  paths: ReadonlySet<string>;
  anchor: string | null;
}
export const NO_SELECTION: Selection = { paths: new Set(), anchor: null };

type TreeClipboard = { paths: string[]; isCut: boolean };

/** What the project file tree's pointer and keyboard handlers act on: its
 *  state, its setters and its actions, as of this render. */
export interface ProjectTreeInputContext {
  root: string;
  ops: ProjectFileOps;
  rowsRef: RefObject<readonly TreeRowData[]>;
  scrollRef: RefObject<HTMLDivElement | null>;
  selection: Selection;
  setSelection: Dispatch<SetStateAction<Selection>>;
  focused: string | null;
  setFocused: Dispatch<SetStateAction<string | null>>;
  setMenuTarget: Dispatch<SetStateAction<TreeRowData | null>>;
  setScrollTarget: Dispatch<SetStateAction<{ path: string; center: boolean } | null>>;
  setRenaming: Dispatch<SetStateAction<string | null>>;
  setDeleteTargets: Dispatch<SetStateAction<TreeRowData[] | null>>;
  clipboard: TreeClipboard | null;
  setClipboard: Dispatch<SetStateAction<TreeClipboard | null>>;
  onShowDiff?: (path: string) => void;
  /** A file row's Ask button: ask the agent about it, from `anchor`. */
  onAskAgent?: (row: TreeRowData, anchor: Element) => void;
  selectOnly: (path: string) => void;
  activate: (row: TreeRowData) => void;
  isOpen: (row: TreeRowData) => boolean;
  setOpen: (row: TreeRowData, open: boolean) => void;
  targetsFor: (row: TreeRowData) => TreeRowData[];
  copyText: (text: string) => void;
  paste: (destRel: string) => void;
  dirForPaste: (row: TreeRowData | null) => string;
}

/**
 * The project file tree's pointer and keyboard handlers, built fresh each
 * render from that render's state (as they were when inline in
 * `ProjectFileTree`).
 */
export function projectTreeInput({
  root,
  ops,
  rowsRef,
  scrollRef,
  selection,
  setSelection,
  focused,
  setFocused,
  setMenuTarget,
  setScrollTarget,
  setRenaming,
  setDeleteTargets,
  clipboard,
  setClipboard,
  onShowDiff,
  onAskAgent,
  selectOnly,
  activate,
  isOpen,
  setOpen,
  targetsFor,
  copyText,
  paste,
  dirForPaste,
}: ProjectTreeInputContext) {
  // ── Pointer ─────────────────────────────────────────────────────────────
  const rowAt = (target: EventTarget | null): TreeRowData | null => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>("[data-rel-path]");
    const rel = el?.dataset.relPath;
    if (rel === undefined) return null;
    return rowsRef.current.find((r) => r.path === rel) ?? null;
  };

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("input")) return;
    const row = rowAt(target);
    if (!row) return;
    const askButton = target.closest("[data-tree-action='ask']");
    if (askButton) {
      onAskAgent?.(row, askButton);
      return;
    }
    if (target.closest("[data-tree-action='diff']")) {
      onShowDiff?.(row.path);
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelection((s) => {
        const paths = new Set(s.paths);
        if (paths.has(row.path)) paths.delete(row.path);
        else paths.add(row.path);
        return { paths, anchor: row.path };
      });
      setFocused(row.path);
      return;
    }
    if (e.shiftKey && selection.anchor) {
      selectRange(selection.anchor, row.path);
      setFocused(row.path);
      return;
    }
    selectOnly(row.path);
    activate(row);
  };

  const selectRange = (from: string, to: string) => {
    const all = rowsRef.current;
    const a = all.findIndex((r) => r.path === from);
    const b = all.findIndex((r) => r.path === to);
    if (a < 0 || b < 0) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    setSelection({ paths: new Set(all.slice(lo, hi + 1).map((r) => r.path)), anchor: from });
  };

  const onContextMenu = (e: MouseEvent) => {
    const row = rowAt(e.target);
    setMenuTarget(row);
    if (row && !selection.paths.has(row.path)) selectOnly(row.path);
  };

  // ── Keyboard ────────────────────────────────────────────────────────────
  const moveFocus = (index: number, extend: boolean) => {
    const all = rowsRef.current;
    if (all.length === 0) return;
    const next = all[Math.max(0, Math.min(all.length - 1, index))];
    if (extend) selectRange(selection.anchor ?? focused ?? next.path, next.path);
    else setSelection({ paths: new Set([next.path]), anchor: next.path });
    setFocused(next.path);
    // The virtualizer counts `display` rows, which a new-entry row shifts.
    setScrollTarget({ path: next.path, center: false });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input")) return;
    const all = rowsRef.current;
    const index = focused ? all.findIndex((r) => r.path === focused) : -1;
    const row = index >= 0 ? all[index] : null;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 0) / ROW_HEIGHT) - 1);
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    switch (e.key) {
      case "ArrowDown":
        handled();
        return moveFocus(index + 1, e.shiftKey);
      case "ArrowUp":
        handled();
        return moveFocus(index < 0 ? 0 : index - 1, e.shiftKey);
      case "PageDown":
        handled();
        return moveFocus(index + page, e.shiftKey);
      case "PageUp":
        handled();
        return moveFocus(index - page, e.shiftKey);
      case "Home":
        handled();
        return moveFocus(0, e.shiftKey);
      case "End":
        handled();
        return moveFocus(all.length - 1, e.shiftKey);
      case "ArrowRight":
        if (!row || row.kind !== "directory") return;
        handled();
        if (!isOpen(row)) setOpen(row, true);
        else if (all[index + 1]?.depth === row.depth + 1) moveFocus(index + 1, false);
        return;
      case "ArrowLeft": {
        if (!row) return;
        handled();
        if (isOpen(row)) return setOpen(row, false);
        // A compacted row's parent is the one above its outermost folder.
        const parent = parentOf(row.chain?.[0] ?? row.path);
        if (parent)
          moveFocus(
            all.findIndex((r) => r.path === parent),
            false,
          );
        return;
      }
      case "Enter":
      case "F2":
        // Enter renames, as in Finder and the explorer; Space opens.
        if (!row || mod) return;
        handled();
        return setRenaming(row.path);
      case " ":
        if (!row) return;
        handled();
        return activate(row);
      case "Escape":
        if (selection.paths.size === 0) return;
        handled();
        return setSelection(NO_SELECTION);
      case "Delete":
      case "Backspace":
        if (!row || (e.key === "Backspace" && !mod)) return;
        handled();
        return setDeleteTargets(targetsFor(row));
    }
    if (!mod) return;
    if (key === "c" && e.altKey && row) {
      handled();
      const targets = targetsFor(row).map((r) => (e.shiftKey ? r.path : absoluteOf(root, r.path)));
      return copyText(targets.join("\n"));
    }
    if (e.altKey || e.shiftKey) return;
    if (key === "a") {
      // Every visible row: what a range from the top to the bottom would
      // select. Rows inside collapsed folders aren't shown, so aren't taken.
      const all = rowsRef.current;
      if (all.length === 0) return;
      handled();
      return setSelection({
        paths: new Set(all.map((r) => r.path)),
        anchor: focused ?? all[0].path,
      });
    }
    if ((key === "c" || key === "x") && row) {
      handled();
      return setClipboard({
        paths: targetsFor(row).map((r) => absoluteOf(root, r.path)),
        isCut: key === "x",
      });
    }
    if (key === "v" && clipboard) {
      handled();
      return paste(dirForPaste(row));
    }
    if (key === "d" && row) {
      handled();
      return void ops.duplicate(absoluteOf(root, row.path));
    }
  };

  return { onClick, onContextMenu, onKeyDown };
}
