// Bridge to `commands::fs_entries` — root-relative directory listings with a
// per-entry `ignored` flag, shaped for the virtualised file tree.

import { invoke } from "@tauri-apps/api/core";

export type ProjectEntryKind = "file" | "directory" | "symlink";

export interface ProjectEntry {
  /** Relative to the project root, `/`-separated. */
  path: string;
  /** A symlink is never followed, so the tree does not expand it. */
  kind: ProjectEntryKind;
  /** Matched by a `.gitignore`, `.git/info/exclude` or the global excludes
   *  file, or inside an ignored directory. Omitted when false. */
  ignored?: boolean;
}

export interface DirectoryListing {
  /** The directory as requested (`""` is the root). */
  path: string;
  /** Directories first, then by case-insensitive name. `.git` is never listed. */
  entries: ProjectEntry[];
  /** Set when this one directory could not be read; the rest still answer. */
  error?: string;
}

/**
 * List several directories under `root` in one IPC call. `paths` are
 * root-relative; the answers come back in the same order.
 */
export function readDirectories(root: string, paths: string[]): Promise<DirectoryListing[]> {
  return invoke<DirectoryListing[]>("read_directories", { root, paths });
}

/** One directory: a batch of one. Rejects when that directory failed. */
export async function readDirectory(root: string, path: string): Promise<ProjectEntry[]> {
  const [listing] = await readDirectories(root, [path]);
  if (!listing || listing.error) throw new Error(listing?.error ?? `No listing for ${path}`);
  return listing.entries;
}

// ── Mutations the file tree performs. Paths are absolute. ────────────────

export function createFile(path: string): Promise<void> {
  return invoke("fs_create_file", { path });
}

export function createDirectory(path: string): Promise<void> {
  return invoke("fs_create_dir", { path });
}

export function renamePath(from: string, to: string): Promise<void> {
  return invoke("fs_rename", { from, to });
}

export function deletePath(path: string): Promise<void> {
  return invoke("fs_delete", { path });
}

export function copyPath(from: string, to: string): Promise<void> {
  return invoke("fs_copy", { from, to });
}

/** Copies beside the original under a free " copy" name; answers the new path. */
export function duplicatePath(path: string): Promise<string> {
  return invoke<string>("fs_duplicate", { path });
}

export function openInTerminal(path: string): Promise<void> {
  return invoke("fs_open_in_terminal", { path });
}

export function addToGitignore(projectPath: string, pattern: string): Promise<void> {
  return invoke("fs_add_to_gitignore", { projectPath, pattern });
}

/** Re-point the mention picker's recent-files entry after a rename or move. */
export function renameRecentFile(
  oldPath: string,
  newPath: string,
  workspaceId: string | null,
): Promise<unknown> {
  return invoke("recent_files_rename", { oldPath, newPath, workspaceId });
}
