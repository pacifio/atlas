// The session checkout's git state, read by path: `git_snapshot` (branch,
// upstream, ahead / behind, files, branches) beside `git_branch_compare`
// (where the branch stands against the default branch).
//
// It is read again when the window comes back into focus or into view
// (debounced, so a focus and a visibility change are one read), when the
// watcher reports a change in that checkout, when a streamed git op there
// finishes, and after each action the card runs (`refreshSessionGit`). The
// same op stream feeds the Commit row its live output line.

import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import type { GitOpEvent } from "@/features/git/stores/git-store";

import { useGitActionStore } from "../stores/git-action-store";
import {
  gitBranchCompare,
  gitSnapshot,
  type BranchCompare,
  type SessionGitSnapshot,
} from "./session-git-api";

export interface SessionGit {
  snapshot: SessionGitSnapshot;
  compare: BranchCompare | null;
}

const ROOT = "session-git";
const FOCUS_DEBOUNCE_MS = 250;

export const sessionGitKey = (path: string) => [ROOT, path] as const;

async function readSessionGit(path: string): Promise<SessionGit> {
  const [snapshot, compare] = await Promise.all([
    gitSnapshot(path),
    // A repository with no commits, or one git refuses, still has a status.
    gitBranchCompare(path).catch(() => null),
  ]);
  return { snapshot, compare: snapshot.isRepo ? compare : null };
}

/** Read the checkout at `path` again, wherever the card shows it. */
export function refreshSessionGit(client: QueryClient, path: string): Promise<void> {
  return client.invalidateQueries({ queryKey: sessionGitKey(path) });
}

export function useSessionGit(path: string | null) {
  const client = useQueryClient();
  useRefreshTriggers(client);
  return useQuery({
    queryKey: sessionGitKey(path ?? ""),
    queryFn: () => readSessionGit(path!),
    enabled: !!path,
    staleTime: 5_000,
  });
}

let installedFor: QueryClient | null = null;

/** One set of listeners for every card: they invalidate by path, and only
 *  the queries a card has mounted refetch. */
function useRefreshTriggers(client: QueryClient) {
  useEffect(() => {
    if (installedFor === client) return;
    installedFor = client;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => void client.invalidateQueries({ queryKey: [ROOT] }),
        FOCUS_DEBOUNCE_MS,
      );
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    void listen<{ project: string }>("atlas:git-changed", (e) => {
      void refreshSessionGit(client, e.payload.project);
    });
    void listen<GitOpEvent>("atlas:git:op", (e) => {
      const p = e.payload;
      // The Commit row's live line: the latest output of the op it runs. A
      // batch only ever shows its last non-blank line.
      if (p.phase === "output") {
        for (let i = p.lines.length - 1; i >= 0; i--) {
          if (!p.lines[i].line.trim()) continue;
          useGitActionStore.getState().actions.output(p.opId, p.lines[i].line);
          break;
        }
      }
      if (p.phase === "done") void refreshSessionGit(client, p.repo);
    });
  }, [client]);
}
