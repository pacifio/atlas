// The uncommitted changes of a repository, shaped for decorating a file tree:
// a status colour and +/- counts per changed file, and the strongest status
// below each folder for the collapsed-folder marker.
//
// It reads the same `git_diff_preview` query the diff view does (same key, so
// one fetch serves both views of a review panel) and takes its working-tree
// source, whatever scope the diff view is showing: the tree marks what is
// uncommitted on disk, as the explorer always has.

import { useEffect, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import {
  buildGitStatusOverlay,
  gitStatusPresentation,
  type GitStatusPresentation,
} from "@/features/explorer/lib/git-status-presentation";
import { useDiffPanelStore } from "../stores/diff-panel-store";
import { getDiffPreview, type DiffFileStat, type DiffFileStatus } from "./git-review-api";

/** The porcelain letter each status paints as, for `gitStatusPresentation`. */
const PORCELAIN: Record<DiffFileStatus, string> = {
  added: "A",
  untracked: "?",
  modified: "M",
  renamed: "R",
  copied: "C",
  deleted: "D",
  conflicted: "U",
};

export interface FileChange {
  stat: DiffFileStat;
  color: string;
}

export interface WorkingTreeChanges {
  /** Keyed by absolute path. */
  files: ReadonlyMap<string, FileChange>;
  /** Keyed by absolute path: the strongest change anywhere below. */
  dirs: ReadonlyMap<string, GitStatusPresentation>;
}

const NONE: WorkingTreeChanges = { files: new Map(), dirs: new Map() };

export function workingTreeChanges(
  root: string,
  stats: readonly DiffFileStat[],
): WorkingTreeChanges {
  if (stats.length === 0) return NONE;
  const { dirtyDirs } = buildGitStatusOverlay(
    stats.map((s) => ({ path: s.path, status: PORCELAIN[s.status] ?? "M" })),
    root,
  );
  const files = new Map<string, FileChange>();
  for (const stat of stats) {
    files.set(`${root}/${stat.path}`, {
      stat,
      color: gitStatusPresentation(PORCELAIN[stat.status] ?? "M").color,
    });
  }
  return { files, dirs: dirtyDirs };
}

export function useWorkingTreeChanges(repoPath: string | null): WorkingTreeChanges {
  const baseRef = useDiffPanelStore((s) => (repoPath ? (s.baseRef[repoPath] ?? null) : null));
  const storedWhitespace = useDiffPanelStore.use.ignoreWhitespace();
  const settingWhitespace = useSettingsStore((s) => s.settings.diffIgnoreWhitespace);
  const ignoreWhitespace = storedWhitespace ?? settingWhitespace;

  // The diff view's key, exactly: see the header.
  const preview = useQuery({
    queryKey: ["git-diff-preview", repoPath, baseRef, ignoreWhitespace],
    queryFn: () => getDiffPreview(repoPath!, { baseRef: baseRef ?? undefined, ignoreWhitespace }),
    enabled: !!repoPath,
    placeholderData: keepPreviousData,
    staleTime: 2_000,
  });
  const { refetch } = preview;

  // Live, as the diff view is: coalesced, since an edit is a burst of events.
  useEffect(() => {
    if (!repoPath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refetch(), 250);
    };
    const offGit = listen<{ project: string }>("atlas:git-changed", (e) => {
      if (e.payload?.project === repoPath) soon();
    });
    const offFs = listen("atlas:explorer:changed", soon);
    return () => {
      if (timer) clearTimeout(timer);
      void offGit.then((off) => off());
      void offFs.then((off) => off());
    };
  }, [repoPath, refetch]);

  const stats = preview.data?.sources.find((s) => s.kind === "working-tree")?.files;
  return useMemo(
    () => (repoPath && stats ? workingTreeChanges(repoPath, stats) : NONE),
    [repoPath, stats],
  );
}
