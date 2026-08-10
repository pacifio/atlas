// Open a turn's changes in the full-screen side-by-side diff viewer.
//
// Imperative, via a window event, for the same reason the detail panel has its
// own store: the transcript must not re-render because a modal opened. A row
// fires this and forgets; `ChatPanel` listens and owns the modal state.
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
// The viewer itself is still the repository one (`GitDiffPanel`) — it just gets
// handed text instead of a repo path. See its `textSources` prop.

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

/**
 * Git speaks repo-relative paths; tool calls report absolute ones. Normalising
 * here means the tree filter and the diff request agree on identity — without
 * it the filter matches nothing and the tree comes back empty.
 */
export function toRepoRelative(path: string, repoPath: string): string {
  if (!repoPath) return path;
  const root = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}
