// What a file tab's frame tells the file inside it: the project the file is
// shown in, whether a tab names it, how its breadcrumbs reach the tree, and
// the tree toggle in its toolbar.
//
// The file's breadcrumbs walk the tree docked beside it. A folder crumb
// reveals that folder there (showing the tree first when it is hidden), and
// the crumbs keep the deeper trail down to the file so the way back is one
// click. The tree is the column's, not the file's (`file-dock.tsx`), so the
// column owns that state and hands it to the frame of its active tab.

import { createContext, useContext } from "react";

export interface FileTabFrameValue {
  /** The tab's project root, absolute; null when the file is outside it. */
  root: string | null;
  projectName: string | null;
  /**
   * A tab in a strip names the file (icon, name, unsaved dot). False in the
   * main column, which has no strip: there the breadcrumbs carry the file's
   * identity themselves.
   */
  titled: boolean;
  /** The folder the crumbs walked up to, root-relative; null while at the file. */
  crumbFolder: string | null;
  /** Reveal a root-relative folder in the tree, showing the tree if hidden. */
  revealFolder: (path: string) => void;
  /** Back down to the file: reveal it in the tree again. */
  revealFile: () => void;
  /** Whether the docked tree is beside the file; false outside the project. */
  treeShown: boolean;
  /** The toolbar's tree toggle: show or hide the docked tree. */
  toggleTree: () => void;
}

export const FileTabFrameContext = createContext<FileTabFrameValue | null>(null);

/** The frame around this file tab; null outside one. */
export function useFileTabFrame(): FileTabFrameValue | null {
  return useContext(FileTabFrameContext);
}

/**
 * What a column's docked tree (`FileDockColumn`) tells the file frames inside
 * it. One tree per column serves every file tab in it, so it is told which
 * tab is on screen and what that tab's breadcrumbs asked for.
 */
export interface FileDockValue {
  /** The column's active tab id. */
  activeTabId: string | null;
  /** The folder the active file's crumbs walked up to; null at the file. */
  crumbFolder: string | null;
  revealFolder: (path: string) => void;
  revealFile: () => void;
}

export const FileDockContext = createContext<FileDockValue | null>(null);

export function useFileDock(): FileDockValue | null {
  return useContext(FileDockContext);
}
