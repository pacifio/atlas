// Bridge to the native `git_blame_file` command — per-line blame for the
// editor's inline annotation. Empty array ⇒ untracked file / not a repo.

import { invoke } from "@tauri-apps/api/core";

export interface BlameLine {
  /** 1-based line number in the current file. */
  line: number;
  sha: string;
  shortSha: string;
  author: string;
  /** Author time as unix milliseconds (0 if unparsable). */
  timeMs: number;
  summary: string;
  /** False for lines git attributes to "Not Committed Yet". */
  committed: boolean;
}

export function gitBlameFile(
  repoPath: string,
  file: string,
): Promise<BlameLine[]> {
  return invoke<BlameLine[]>("git_blame_file", { path: repoPath, file });
}
