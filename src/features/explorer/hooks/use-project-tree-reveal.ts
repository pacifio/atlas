import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { ProjectTreeModel } from "../lib/project-tree-model";
import { relativeTo } from "../lib/project-file-ops";
import { NO_SELECTION, type Selection } from "../lib/project-tree-input";
import { useActiveFilePath } from "./use-active-file-path";

/**
 * The project file tree following the reader: the active file revealed and
 * focused, and a folder the breadcrumbs walked up to opened, selected and
 * centred. Lifted out of `ProjectFileTree` whole; its hooks run in the same
 * order they did there. Returns the active file, absolute.
 */
export function useProjectTreeReveal({
  model,
  root,
  activeFile,
  revealNonce,
  revealFolder,
  clearSearch,
  setSelection,
  setFocused,
  setScrollTarget,
  scrollRef,
}: {
  model: ProjectTreeModel;
  root: string;
  activeFile: string | null | undefined;
  revealNonce: number;
  revealFolder: { path: string; nonce: number } | null;
  clearSearch: () => void;
  setSelection: Dispatch<SetStateAction<Selection>>;
  setFocused: Dispatch<SetStateAction<string | null>>;
  setScrollTarget: Dispatch<SetStateAction<{ path: string; center: boolean } | null>>;
  scrollRef: RefObject<HTMLDivElement | null>;
}): { activeAbs: string | null } {
  // ── Reveal the active file ──────────────────────────────────────────────
  const lastViewed = useActiveFilePath();
  const activeAbs = activeFile !== undefined ? activeFile : lastViewed;
  const activeRel = activeAbs ? relativeTo(root, activeAbs) : null;
  // A file opened from the tree is already in view: revealing it must not
  // end the search it was picked from. Anything else that points the tree
  // at a file (another tab, ⌘P, an agent) does.
  // Kept on the model: the tree that reveals it is often a different view
  // (the file's tab) from the one that opened it (the Files surface).
  useEffect(() => {
    if (!activeRel) return;
    if (activeAbs !== model.view.openedFromTree) clearSearch();
    let cancelled = false;
    void model.reveal(activeRel).then((index) => {
      if (cancelled || index < 0) return;
      setFocused(activeRel);
      setScrollTarget({ path: activeRel, center: false });
    });
    return () => {
      cancelled = true;
    };
    // `activeAbs` moves with `activeRel`; `clearSearch` is stable.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [model, activeRel, revealNonce]);

  // A folder the breadcrumbs walked up to: open the way to it, select it and
  // bring it to the middle. The root has no row; it scrolls to the top.
  const folderPath = revealFolder?.path ?? null;
  const folderNonce = revealFolder?.nonce ?? 0;
  useEffect(() => {
    if (folderPath === null) return;
    clearSearch();
    if (folderPath === "") {
      setSelection(NO_SELECTION);
      setFocused(null);
      scrollRef.current?.scrollTo({ top: 0 });
      return;
    }
    let cancelled = false;
    void model.reveal(folderPath).then((index) => {
      if (cancelled || index < 0) return;
      setSelection({ paths: new Set([folderPath]), anchor: folderPath });
      setFocused(folderPath);
      setScrollTarget({ path: folderPath, center: true });
    });
    return () => {
      cancelled = true;
    };
    // Per request: `clearSearch` is stable.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [model, folderPath, folderNonce]);

  return { activeAbs };
}
