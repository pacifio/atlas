// Bridge to the native `git_blame_file` command — per-line blame (author,
// time, commit summary) for the editor's inline blame feature. Mirrors the
// shape of `git-diff-api.ts`.

import { invoke } from "@tauri-apps/api/core";

export interface BlameLine {
  /** 1-based line number in the current file. */
  line: number;
  sha: string;
  shortSha: string;
  author: string;
  /** Author time as unix milliseconds (0 if unknown). */
  timeMs: number;
  summary: string;
  /** False for locally-modified / uncommitted lines. */
  committed: boolean;
}

/**
 * Blame `file` (relative to `repoPath`) against the working tree. Resolves to
 * an empty array when the file isn't tracked or the path isn't a git repo.
 */
export function gitBlameFile(repoPath: string, file: string): Promise<BlameLine[]> {
  return invoke<BlameLine[]>("git_blame_file", { path: repoPath, file });
}
