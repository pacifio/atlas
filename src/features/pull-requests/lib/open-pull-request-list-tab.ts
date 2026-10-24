import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

/** The tab id for one repository's list: `pull-requests:<checkout>`. One per
 *  checkout, so opening it again only focuses it. */
export function pullRequestListTabId(repoPath: string): string {
  return `pull-requests:${repoPath}`;
}

/** What a list tab persists (`tab.data`), and so what restores it. */
export interface PullRequestListTabData {
  repoPath: string;
}

export function readPullRequestListTabData(
  data: Record<string, unknown>,
): PullRequestListTabData | null {
  return typeof data.repoPath === "string" && data.repoPath ? { repoPath: data.repoPath } : null;
}

/** The checkout the open project lives in, which ⌘T and the palette list. */
export function currentRepoPath(): string | null {
  return useAppStore.getState().currentProject?.path ?? null;
}

/**
 * Open a repository's pull requests in a surface tab beside the session
 * (ADR-0024), or focus the one already open. `groupId` is the column to open
 * in, when the caller has one (⌘T's column); otherwise the layout picks the
 * surfaces pane. The tab persists with the project's layout.
 *
 * The opener every entry point calls: ⌘T, the command palette, the overlay's
 * "View all pull requests" and the project picker's menu.
 */
export function openPullRequestListTab(opts: {
  repoPath: string;
  /** For the tab strip; the folder name otherwise. */
  name?: string;
  groupId?: string;
}): void {
  const { repoPath, groupId } = opts;
  const id = pullRequestListTabId(repoPath);
  const layout = useLayoutStore.getState();
  if (layout.tabs.some((t) => t.id === id)) {
    layout.actions.setActiveTab(id);
    return;
  }
  const name = opts.name ?? repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
  const data: PullRequestListTabData = { repoPath };
  layout.actions.addTab(
    {
      id,
      type: "pull-requests",
      title: `Pull requests · ${name}`,
      closable: true,
      dirty: false,
      data: { ...data },
    },
    groupId,
  );
}
