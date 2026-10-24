import { useLayoutStore } from "@/features/layout/stores/layout-store";

/** The tab id for one session's pull requests:
 *  `session-pull-requests:<threadId>`. One per session, so opening it again
 *  only focuses it. */
export function sessionPullRequestsTabId(threadId: string): string {
  return `session-pull-requests:${threadId}`;
}

/** What the tab persists (`tab.data`), and so what restores it. */
export interface SessionPullRequestsTabData {
  /** The session's history row, which the links ride on. */
  threadId: string;
  /** The session's checkout: a number typed into + Link is read there, and
   *  a link is looked for there first. */
  cwd: string | null;
}

export function readSessionPullRequestsTabData(
  data: Record<string, unknown>,
): SessionPullRequestsTabData | null {
  if (typeof data.threadId !== "string" || !data.threadId) return null;
  const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : null;
  return { threadId: data.threadId, cwd };
}

/** "Pull requests · <session>", trimmed to fit a tab. */
export function sessionPullRequestsTabTitle(title?: string | null): string {
  const name = title?.trim();
  if (!name) return "Pull requests";
  return `Pull requests · ${name.length > 32 ? `${name.slice(0, 31)}…` : name}`;
}

/**
 * Open a session's pull requests in a surface tab beside the session
 * (ADR-0024), or focus the one already open. The tab persists with the
 * project's layout.
 *
 * The opener every entry point calls: the sidebar badge (with more than one
 * linked), the session context overlay's count, and the session row's menu.
 */
export function openSessionPullRequestsTab(opts: {
  threadId: string;
  cwd: string | null;
  /** The session's title, for the tab strip. */
  title?: string | null;
  groupId?: string;
}): void {
  const { threadId, cwd, groupId } = opts;
  const id = sessionPullRequestsTabId(threadId);
  const layout = useLayoutStore.getState();
  if (layout.tabs.some((t) => t.id === id)) {
    layout.actions.setActiveTab(id);
    return;
  }
  const data: SessionPullRequestsTabData = { threadId, cwd };
  layout.actions.addTab(
    {
      id,
      type: "session-pull-requests",
      title: sessionPullRequestsTabTitle(opts.title),
      closable: true,
      dirty: false,
      data: { ...data },
    },
    groupId,
  );
}
