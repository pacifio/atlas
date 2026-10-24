/**
 * Stale-while-revalidate for warm project switches.
 *
 * After `restoreSnapshot` paints the cached UI instantly, we kick a
 * NON-BLOCKING background refresh of the cheap-but-possibly-stale data (git
 * status, the project tree). Steady-state freshness also arrives
 * via the resident watchers (`atlas:git-changed`, `atlas:explorer:changed`),
 * so this mainly covers changes that happened while the project was
 * backgrounded.
 *
 * Generation guard: we capture the active project id at dispatch and re-check
 * it right before each refresh applies, so a rapid A→B→A doesn't let B's late
 * refresh clobber A. Authoritative-in-RAM stores (layout/editor/terminal/chat/
 * knowledge) are intentionally NOT revalidated — reloading them would discard
 * live/unsaved state.
 */

import { useGitStore } from "@/features/git/stores/git-store";
import { refreshProjectTree } from "@/features/explorer/lib/project-tree-model";
import { useProjectStore } from "../stores/project-store";

export function revalidateProject(projectId: string, path: string): void {
  const stillActive = () => useProjectStore.getState().activeProjectId === projectId;

  // Git status — quick; the resident watcher keeps it fresh thereafter.
  if (stillActive()) {
    void useGitStore
      .getState()
      .actions.loadStatus(path)
      .catch(() => {});
  }

  // The project tree, if one is cached — re-reads the folders on screen and
  // marks the rest to re-read when opened (cheap).
  if (stillActive()) refreshProjectTree(path);
}
