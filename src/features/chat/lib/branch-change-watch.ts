// Notice when an agent turn moves its checkout to another branch: read the
// branch as the turn starts and again as it ends, and record the pair when
// they differ (`branch-change-store.ts`). The composer's strip offers the way
// back (`branch-changed-bar.tsx`).
//
// Watched here rather than in the composer so a turn that ends while its tab
// is in the background is still caught. A turn is the stretch the session is
// busy — running, or waiting on the user mid-turn — so a permission prompt
// does not split one turn into two.

import { isBusyAgentStatus } from "@/types/agent";
import { checkoutState } from "@/features/git/lib/git-remote-api";
import { useChatStore } from "../stores/chat-store";
import { useBranchChangeStore } from "../stores/branch-change-store";

type Checkout = Awaited<ReturnType<typeof checkoutState>>;

/** Start a watch over every session's turns. Returns the unsubscribe. */
export function watchTurnBranchChanges(): () => void {
  // Tab id → the checkout as its running turn found it. A promise, so a turn
  // shorter than the read still compares against the right start.
  const starts = new Map<string, { cwd: string; checkout: Promise<Checkout> }>();

  const turnStarted = (tabId: string, cwd: string) => {
    // A new turn answers for itself; the last one's notice is stale.
    useBranchChangeStore.getState().actions.clear(tabId);
    starts.set(tabId, { cwd, checkout: checkoutState(cwd) });
  };

  const turnEnded = async (tabId: string) => {
    const start = starts.get(tabId);
    starts.delete(tabId);
    if (!start) return;
    const [before, after] = await Promise.all([start.checkout, checkoutState(start.cwd)]);
    // Nothing to go back to from a detached start, or an unreadable one.
    if (!before || !after || before.detached || before.branch === after.branch) return;
    // Another turn began meanwhile and owns the notice now.
    if (starts.has(tabId)) return;
    useBranchChangeStore
      .getState()
      .actions.record(tabId, { cwd: start.cwd, was: before.branch, now: after.branch });
  };

  return useChatStore.subscribe((state, prev) => {
    if (state.sessions === prev.sessions) return;
    for (const [tabId, session] of Object.entries(state.sessions)) {
      const busy = isBusyAgentStatus(session.status);
      const wasBusy = isBusyAgentStatus(prev.sessions[tabId]?.status);
      if (busy === wasBusy) continue;
      if (busy && session.workingDirectory) turnStarted(tabId, session.workingDirectory);
      else if (!busy) void turnEnded(tabId);
    }
    // A closed tab's turn has nobody to tell.
    for (const tabId of starts.keys()) if (!state.sessions[tabId]) starts.delete(tabId);
  });
}
