/**
 * Where a session notification goes when it is clicked, and what a session
 * with no tab is called in one.
 *
 * A session target normally names the tab showing it. A session that no tab
 * shows — a pull request watch woke it in the background — carries its
 * `threadId` instead, and a click resumes it from history the way a sidebar
 * click does (`openThread`).
 */
import { jumpToSession } from "@/features/chat/lib/tab-project";
import { threadProjects } from "@/features/chat/lib/history-api";
import { sidebarAgentOf } from "@/features/chat/lib/sidebar-agents";
import { activeOrgProjectsSnapshot } from "@/features/projects/lib/org-scope";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { matchProject } from "@/features/sidebar/lib/sidebar-sessions";
import type { Project } from "@/features/projects/stores/project-store";
import { findHistorySession, type HistorySession } from "./agent-notifier-rules";

/** The open tab showing ACP session `sessionId`, if one does. A chat-store
 *  session outlives its closed tab, so the tab itself must still exist. */
export function openTabForSession(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const tabs = new Set(useLayoutStore.getState().tabs.map((t) => t.id));
  for (const [tabId, session] of Object.entries(useChatStore.getState().sessions)) {
    if (session.acpSessionId === sessionId && tabs.has(tabId)) return tabId;
  }
  return null;
}

/** A session no tab shows, as history lists it, with the project it belongs
 *  to (the active organisation's first, then any). */
export interface ResolvedHistorySession extends HistorySession {
  project: Project | null;
  /** Where it resumes. */
  cwd: string;
}

export async function resolveHistorySession(
  threadId: string,
  sessionId?: string,
): Promise<ResolvedHistorySession | null> {
  const found = findHistorySession(await threadProjects(""), threadId, sessionId);
  if (!found) return null;
  const paths = [...found.row.folderPaths, ...found.groupPaths];
  const project =
    matchProject(paths, activeOrgProjectsSnapshot()) ??
    matchProject(paths, useProjectStore.getState().projects);
  const fromStore = project
    ? (useProjectStore.getState().projects.find((p) => p.id === project.id) ?? null)
    : null;
  return { ...found, project: fromStore, cwd: paths[0] ?? fromStore?.path ?? "" };
}

/** Open a session target: its tab when one shows it, else resumed from
 *  history by its thread id. */
export async function openSessionTarget(t: {
  tabId: string;
  sessionId?: string;
  threadId?: string;
}): Promise<void> {
  const tabs = useLayoutStore.getState().tabs;
  if (t.tabId && tabs.some((tab) => tab.id === t.tabId)) return jumpToSession(t.tabId);
  const shown = openTabForSession(t.sessionId);
  if (shown) return jumpToSession(shown);
  if (!t.threadId) {
    // Nothing to resume from: the old best effort.
    if (t.tabId) await jumpToSession(t.tabId);
    return;
  }
  const resolved = await resolveHistorySession(t.threadId, t.sessionId);
  if (!resolved) return;
  const { row, project, cwd } = resolved;
  // Loaded on use: resuming a session pulls in the whole bind path.
  const { openThread } = await import("@/features/chat/lib/open-thread");
  await openThread({
    threadId: row.threadId,
    sessionId: row.sessionId ?? "",
    title: row.title,
    agent: sidebarAgentOf(row.agentId),
    cwd,
    projectPath: project?.path ?? cwd,
  });
}
