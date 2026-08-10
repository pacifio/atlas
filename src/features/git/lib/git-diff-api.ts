// Bridge to the native `atlas-gitdiff` engine (Rust) — structured side-by-side
// diffs with word-level change spans, plus editor-gutter line classification.

import { invoke } from "@tauri-apps/api/core";
import type { QueryClient } from "@tanstack/react-query";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

export type DiffLineKind = "context" | "added" | "removed" | "changed";

export interface DiffSegment {
  text: string;
  /** A word-level changed span within a modified line. */
  emph: boolean;
}

export interface DiffSide {
  lineNo: number;
  kind: DiffLineKind;
  segments: DiffSegment[];
}

export interface DiffRow {
  left: DiffSide | null;
  right: DiffSide | null;
}

export interface FileDiff {
  path: string;
  language: string;
  isBinary: boolean;
  rows: DiffRow[];
  stats: { additions: number; deletions: number };
  /** Row indices that start a contiguous change — for "N differences" + nav. */
  changeBlocks: number[];
}

export interface DiffLineStatus {
  added: number[];
  changed: number[];
  deletedBefore: number[];
}

/**
 * Cache key for one file's structured diff.
 *
 * Shared rather than inlined in the viewer so a caller can PREFETCH under the
 * exact same key. The chat knows a turn's before/after text at the moment the
 * reader clicks, but the fetch would otherwise not start until the modal had
 * mounted — serialising an IPC round trip behind the open animation instead of
 * overlapping it.
 */
export function diffQueryKey(
  repoPath: string,
  file: string,
  staged: boolean,
  commit: string | null,
  textSource?: { old: string; new: string },
) {
  return [
    "git-diff",
    repoPath,
    file,
    staged,
    commit,
    // Part of the key: two turns editing the same path must not share an entry,
    // and they differ only by their text.
    textSource ? `${textSource.old.length}:${textSource.new.length}` : null,
  ] as const;
}

/** Warm the cache for a text-sourced diff, so the viewer mounts onto data. */
export function prefetchTextDiff(
  queryClient: QueryClient,
  repoPath: string,
  file: string,
  source: { old: string; new: string },
): void {
  if (!file) return;
  void queryClient.prefetchQuery({
    queryKey: diffQueryKey(repoPath, file, false, null, source),
    queryFn: () => diffStructuredText(source.old, source.new, file),
    staleTime: 10_000,
  });
}

export function gitDiffStructured(
  repoPath: string,
  file: string,
  staged: boolean,
  /** When set, show the diff introduced by this commit (via `git show`). */
  commit?: string | null,
): Promise<FileDiff> {
  return invoke<FileDiff>("git_diff_structured", {
    path: repoPath,
    file,
    staged,
    commit: commit ?? null,
  });
}

/**
 * Structured diff between two texts — no repository involved.
 *
 * For agent-turn changes, whose before/after text lives only in the tool call's
 * arguments. Git cannot answer for those: the working tree is the current state,
 * not the state at that turn.
 *
 * NOTE on scope: `Edit`-style calls carry FRAGMENTS (the replaced snippet), so
 * the diff covers that fragment and its line numbers start at 1. `Write` calls
 * carry whole content and diff faithfully — which is why a newly created file
 * renders in full.
 */
export function diffStructuredText(
  oldText: string,
  newText: string,
  file: string,
): Promise<FileDiff> {
  return invoke<FileDiff>("diff_structured_text", { oldText, newText, file });
}

export interface CommitFile {
  path: string;
  status: string;
}

/** Files changed by a single commit (for the diff viewer's commit browser). */
export function gitCommitChangedFiles(repoPath: string, sha: string): Promise<CommitFile[]> {
  return invoke<CommitFile[]>("git_commit_changed_files", { path: repoPath, sha });
}

export function gitDiffLineStatus(
  repoPath: string,
  file: string,
  staged: boolean,
): Promise<DiffLineStatus> {
  return invoke<DiffLineStatus>("git_diff_line_status", { path: repoPath, file, staged });
}

/**
 * Open (or focus) the dedicated side-by-side diff tab for a file. Tabs are keyed
 * by file + staged-ness so the staged and worktree diffs of the same file are
 * distinct tabs and re-opening focuses the existing one.
 */
export function openGitDiff(
  repoPath: string,
  file: string,
  staged: boolean,
  commit?: string | null,
): void {
  const base = file.split("/").pop() ?? file;
  const id = `diff:${file}:${staged ? "s" : "w"}${commit ? `:${commit}` : ""}`;
  const { addTab, setActiveTab } = useLayoutStore.getState().actions;
  addTab({
    id,
    type: "diff",
    title: base,
    closable: true,
    dirty: false,
    data: { repoPath, file, staged, commit: commit ?? null },
  });
  setActiveTab(id);
}
