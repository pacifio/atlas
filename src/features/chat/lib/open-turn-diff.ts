// Open a turn's changes in the review panel beside the session, in the turn's
// own scope, scrolled to a file.
//
// Imperative, via a window event, for the same reason the detail panel has its
// own store: the transcript must not re-render because a panel opened. A row
// fires this and forgets; `ChatPanel` listens and hands it to `showTurnDiff`.
//
// ── What the viewer actually shows ────────────────────────────────────────
//
// The TURN's own before/after text, from the tool call arguments — never git.
// This was tried the other way first and it does not work: git answers for the
// CURRENT working tree, while a file created in turn 1, edited in turn 2 and
// deleted in turn 3 has one git answer and three different correct diffs. Once
// the edits are committed git reports nothing at all, so every past turn went
// blank.
//
// The panel's turn scope is handed text instead of a repo path: the backend
// diffs each before/after (`diff_texts_patch`). See `use-turn-review-files.ts`.

/** Payload of the `atlas:open-turn-diff` event. */
export interface TurnDiffRequest {
  /** The turn to show. `ChatPanel` resolves its edits from the message log. */
  turnId: string;
  /** Optional single file to open on; empty opens the turn's first. */
  file?: string;
}

export const OPEN_TURN_DIFF_EVENT = "atlas:open-turn-diff";

export function openTurnDiff(turnId: string, file?: string): void {
  if (!turnId) return;
  window.dispatchEvent(
    new CustomEvent<TurnDiffRequest>(OPEN_TURN_DIFF_EVENT, { detail: { turnId, file } }),
  );
}

/** A Windows path: `C:\…`, `C:/…`, or a UNC `\\server\…`. */
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]|^\\\\/;

/** True for an absolute path on any platform Atlas runs on. */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE.test(path);
}

/** `file` (repo-relative, `/`-separated) under `root`, in the root's own
 *  separator. */
export function joinPath(root: string, file: string): string {
  const windows = root.includes("\\") && !root.includes("/");
  const base = /[\\/]$/.test(root) ? root.slice(0, -1) : root;
  return windows ? `${base}\\${file.replace(/\//g, "\\")}` : `${base}/${file}`;
}

/**
 * Git speaks repo-relative paths; tool calls report absolute ones. Normalising
 * here means the tree filter and the diff request agree on identity — without
 * it the filter matches nothing and the tree comes back empty.
 *
 * On Windows an agent may write either separator and either drive-letter
 * case, and NTFS does not care, so neither does this: separators become `/`
 * and the root is compared without case.
 */
export function toRepoRelative(path: string, repoPath: string): string {
  if (!repoPath) return path;
  const windows = WINDOWS_ABSOLUTE.test(repoPath) || WINDOWS_ABSOLUTE.test(path);
  if (!windows) {
    const root = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
    return path.startsWith(root) ? path.slice(root.length) : path;
  }
  const p = path.replace(/\\/g, "/");
  const r = repoPath.replace(/\\/g, "/");
  const root = r.endsWith("/") ? r : `${r}/`;
  return p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length) : p;
}
