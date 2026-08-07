/**
 * Stale-while-revalidate for warm workspace switches.
 *
 * After `restoreSnapshot` paints the cached UI instantly, we kick a
 * NON-BLOCKING background refresh of the cheap-but-possibly-stale data (git
 * status, explorer tree). Steady-state freshness also arrives
 * via the resident watchers (`atlas:git-changed`, `atlas:explorer:changed`),
 * so this mainly covers changes that happened while the workspace was
 * backgrounded.
 *
 * Generation guard: we capture the active workspace id at dispatch and re-check
 * it right before each refresh applies, so a rapid A→B→A doesn't let B's late
 * refresh clobber A. Authoritative-in-RAM stores (layout/editor/terminal/chat/
 * knowledge) are intentionally NOT revalidated — reloading them would discard
 * live/unsaved state.
 */

import { useGitStore } from "@/features/git/stores/git-store";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { useWorkspaceStore } from "../stores/workspace-store";

export function revalidateWorkspace(workspaceId: string, path: string): void {
  const stillActive = () => useWorkspaceStore.getState().activeWorkspaceId === workspaceId;

  // Git status — quick; the resident watcher keeps it fresh thereafter.
  if (stillActive()) {
    void useGitStore
      .getState()
      .actions.loadStatus(path)
      .catch(() => {});
  }

  // Explorer — reconcile the loaded tree in place (cheap).
  if (stillActive()) {
    void useExplorerStore
      .getState()
      .actions.refresh()
      .catch(() => {});
  }
}
