import { useLayoutStore } from "@/features/layout/stores/layout-store";

/**
 * Open (or focus) the commit tab: the commit's header and every file it
 * changed, stacked. Keyed by repository + sha, so re-opening a commit focuses
 * its tab and the same sha in another worktree gets its own.
 */
export function openCommit(repoPath: string, sha: string, subject?: string): void {
  const id = `commit:${repoPath}:${sha}`;
  const short = sha.slice(0, 7);
  const { addTab, setActiveTab } = useLayoutStore.getState().actions;
  addTab({
    id,
    type: "commit",
    title: subject ? `${short} — ${subject}` : short,
    closable: true,
    dirty: false,
    data: { repoPath, sha },
  });
  setActiveTab(id);
}
