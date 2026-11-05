// Dropping a pull-request tab's drafts when the tab closes: the layout's tab
// list is watched (once, for the app's life) and any draft whose tab is gone
// is pruned. Started by the first pull-request panel that mounts.

import { useLayoutStore } from "@/features/layout/stores/layout-store";

import { usePullRequestTabDraftStore } from "../stores/pull-request-tab-draft-store";

let watching = false;

export function watchPullRequestTabDrafts(): void {
  if (watching) return;
  watching = true;
  let lastTabs = useLayoutStore.getState().tabs;
  useLayoutStore.subscribe((state) => {
    if (state.tabs === lastTabs) return;
    lastTabs = state.tabs;
    const drafts = usePullRequestTabDraftStore.getState();
    if (Object.keys(drafts.drafts).length === 0) return;
    drafts.actions.prune(new Set(state.tabs.map((tab) => tab.id)));
  });
}
