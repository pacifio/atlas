// The right-click menu on a diff's file header: what it offers for a file.
//
// The same verbs, in the same words, as the project tree's menu on a file
// (`project-file-tree.tsx`): Open, then where else the file can go (Finder,
// the system's default app, an installed editor), then its paths. Open is
// Atlas's own file tab, as a click on the header's name is. A file the change
// deleted has nothing on disk, so only its paths are offered; a diff whose
// files are not on this disk (a pull request's) offers its relative path.

export type DiffFileMenuItem =
  | "open"
  | "reveal"
  | "open-default"
  | "open-in-editor"
  | "copy-path"
  | "copy-relative-path"
  | "separator";

export interface DiffFileMenuTarget {
  /** Whether the change deleted the file. */
  deleted: boolean;
  /** Its absolute path on disk; null when the diff's files are not on disk. */
  absPath: string | null;
  /** Its path in its own root, as "Copy path" on the header copies it. */
  relPath: string;
  /** Whether the diff can open its files (a source with `openFile`). */
  canOpen: boolean;
}

/** The menu's rows, in order, separators between groups and never at an end
 *  or twice. */
export function diffFileMenuItems(target: DiffFileMenuTarget): DiffFileMenuItem[] {
  const onDisk = target.absPath !== null && !target.deleted;
  const groups: DiffFileMenuItem[][] = [
    onDisk && target.canOpen ? ["open"] : [],
    onDisk ? ["reveal", "open-default", "open-in-editor"] : [],
    [...(target.absPath !== null ? (["copy-path"] as const) : []), "copy-relative-path"],
  ];
  const out: DiffFileMenuItem[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (out.length > 0) out.push("separator");
    out.push(...group);
  }
  return out;
}
