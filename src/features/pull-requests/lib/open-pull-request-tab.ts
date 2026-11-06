import { MAX_GROUPS, useLayoutStore } from "@/features/layout/stores/layout-store";

/** The tab id for one pull request: `pull-request:<checkout>:<number>`. One
 *  tab per pull request per checkout, so opening it again only focuses it. */
export function pullRequestTabId(repoPath: string, number: number): string {
  return `pull-request:${repoPath}:${number}`;
}

/** What a pull-request tab persists (`tab.data`), and so what restores it. */
export interface PullRequestTabData {
  /** The checkout the `pr_*` commands run `gh` in. */
  repoPath: string;
  number: number;
  /** The tab it was opened from (the pull-request list, a session's pull
   *  request panel): the header's back arrow returns there while it is open. */
  openedFrom?: string;
}

/** A restored tab's data, or `null` when it no longer names a pull request. */
export function readPullRequestTabData(data: Record<string, unknown>): PullRequestTabData | null {
  const repoPath = typeof data.repoPath === "string" ? data.repoPath : null;
  const number = typeof data.number === "number" ? data.number : Number(data.number);
  if (!repoPath || !Number.isSafeInteger(number) || number <= 0) return null;
  const openedFrom =
    typeof data.openedFrom === "string" && data.openedFrom ? data.openedFrom : undefined;
  return openedFrom ? { repoPath, number, openedFrom } : { repoPath, number };
}

/** The tab strip's label: the number, then the title once it is known. */
export function pullRequestTabTitle(number: number, title?: string | null): string {
  return title ? `#${number} ${title}` : `#${number}`;
}

/**
 * Open a pull request in its own surface tab beside the session (ADR-0024).
 *
 * Already open, anywhere, it is focused. Otherwise it goes into the column
 * already showing another pull request, so reading down a list walks one
 * column; else an empty split; else a new split beside the session; else, at
 * the column limit, the session's neighbour. The tab persists with the
 * project's layout, so it comes back after a restart.
 *
 * The one opener every pull-request entry point calls: the sidebar badge and
 * hover card, the session context overlay's rows, Create PR's success path,
 * and the pull-request list when it lands.
 */
export function openPullRequestTab(opts: {
  repoPath: string;
  number: number;
  /** The title, when the caller already has it; the tab reads it otherwise. */
  title?: string;
  /** The tab opening it, for the back arrow. Opening an open pull request
   *  again from somewhere else moves its arrow there; from nowhere in
   *  particular (a toast, a link), it keeps the one it had. */
  openedFrom?: string;
}): void {
  const { repoPath, number, title, openedFrom } = opts;
  const id = pullRequestTabId(repoPath, number);
  const layout = useLayoutStore.getState();
  const { actions } = layout;
  if (layout.tabs.some((t) => t.id === id)) {
    if (openedFrom && openedFrom !== id) actions.setTabData(id, { openedFrom });
    actions.setActiveTab(id);
    return;
  }

  const groupOf = (t: { groupId?: string }) => t.groupId ?? "main";
  const main = layout.groupOrder[0];
  const sibling = layout.tabs.find((t) => t.type === "pull-request" && groupOf(t) !== main);
  let target = sibling
    ? groupOf(sibling)
    : layout.groupOrder.find((g) => g !== main && !layout.tabs.some((t) => groupOf(t) === g));
  if (!target && layout.groupOrder.length < MAX_GROUPS) {
    actions.addGroup();
    target = useLayoutStore.getState().focusedGroupId;
  }
  if (!target) target = layout.groupOrder[1] ?? main;

  const data: PullRequestTabData =
    openedFrom && openedFrom !== id ? { repoPath, number, openedFrom } : { repoPath, number };
  actions.addTab(
    {
      id,
      type: "pull-request",
      title: pullRequestTabTitle(number, title),
      closable: true,
      dirty: false,
      data: { ...data },
    },
    target,
  );
}
