import { useEffect } from "react";
import { useWorkspaceStore } from "../stores/workspace-store";
import { useWorkspaceGitStore } from "../stores/workspace-git-store";

/**
 * Warm the workspace-pane data at startup so the first sidebar slide is smooth.
 *
 * The only IPC-backed data the pane needs is each workspace's git summary
 * (`git_workspace_summary`). Lazily fetching those when the sidebar first gains
 * size dropped a frame mid-animation (the async result re-rendered the rows).
 * Here we prefetch ALL workspaces' summaries into the module-level cache
 * (`workspace-git-store`) on an idle callback right after boot, so by the time
 * the user opens the pane the rows render straight from cache. The git store
 * dedups (won't refetch) and already refreshes in the background on
 * `atlas:git-changed`, so this is idempotent and cheap on re-runs.
 */
export function useWorkspaceGitPrefetch() {
  // Re-runs only when the SET of workspace paths changes (the signature string
  // is stable otherwise), not on every store mutation.
  const pathsSig = useWorkspaceStore((s) =>
    s.workspaces.map((w) => w.path).join("\n"),
  );

  useEffect(() => {
    if (!pathsSig) return;
    const run = () => {
      const ensure = useWorkspaceGitStore.getState().actions.ensure;
      for (const p of pathsSig.split("\n")) if (p) ensure(p);
    };
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(run, { timeout: 1500 });
      return () => window.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(run, 200);
    return () => window.clearTimeout(id);
  }, [pathsSig]);
}
