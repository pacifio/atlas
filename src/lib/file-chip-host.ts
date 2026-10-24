// The React side of file chips drawn by react-markdown (`file-chip-hast.ts`):
// one delegated click and key listener on the rendered block, never one per
// chip, and the icon theme's icons painted into the chips' slots after every
// commit.
//
// What a click does is the surface's call (`open`). Every surface but the
// pull request's opens through `openFileChipUnder(root)`: Atlas's viewer for a
// file inside the surface's root, and nothing at all otherwise.

import { useCallback, useLayoutEffect, useRef } from "react";
import { paintFileIcons } from "@/features/icon-theme/lib/icon-markup";

/** What a clicked chip names. */
export interface FileChipTarget {
  /** Absolute. */
  path: string;
  line?: number;
  column?: number;
  /** The pull request changed file it names, relative to the checkout. */
  prFile?: string;
}

/** The chip an event landed on, and what it names. */
export function fileChipTargetAt(target: EventTarget | null): FileChipTarget | null {
  const el = (target as HTMLElement | null)?.closest?.(".atlas-file-chip[data-file-path]");
  if (!(el instanceof HTMLElement)) return null;
  const path = el.dataset.filePath;
  if (!path) return null;
  const line = Number(el.dataset.fileLine) || undefined;
  const column = Number(el.dataset.fileColumn) || undefined;
  const prFile = el.dataset.prFile || undefined;
  return {
    path,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    ...(prFile !== undefined ? { prFile } : {}),
  };
}

/** A click on a chip opens it in Atlas's viewer, inside `root` only. */
export function openFileChipUnder(root: string): (target: FileChipTarget) => void {
  return (target) => {
    // Loaded on the first click: the opener pulls in the layout and the file
    // index, which a markdown renderer has no reason to carry.
    void import("@/features/explorer/lib/open-path-link")
      .then((m) => m.openUntrustedPathLink(target, root))
      .catch(() => {});
  };
}

/**
 * Props for the element markdown with chips renders into: a ref (for painting
 * icons), and a click and key handler that open a chip through `open`. A
 * click anywhere else is left alone.
 */
export function useFileChipHost<T extends HTMLElement = HTMLDivElement>(
  open: ((target: FileChipTarget) => void) | null,
) {
  const ref = useRef<T | null>(null);
  const openRef = useRef(open);
  useLayoutEffect(() => {
    openRef.current = open;
  });
  // Every commit: the markdown below may have been re-parsed. A block without
  // chips costs one attribute query.
  useLayoutEffect(() => {
    const node = ref.current;
    if (node?.querySelector("[data-file-icon]")) paintFileIcons(node);
  });
  const onClick = useCallback((e: React.MouseEvent) => {
    const take = openRef.current;
    if (!take) return;
    const target = fileChipTargetAt(e.target);
    if (!target) return;
    e.preventDefault();
    e.stopPropagation();
    take(target);
  }, []);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const take = openRef.current;
    const el = e.target as HTMLElement;
    if (!take || !el.matches?.(".atlas-file-chip[data-file-path]")) return;
    const target = fileChipTargetAt(el);
    if (!target) return;
    e.preventDefault();
    take(target);
  }, []);
  return { ref, onClick, onKeyDown };
}
