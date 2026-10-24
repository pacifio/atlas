/**
 * `ui_state`: what the window shows, read from the stores at the moment of
 * asking. Nothing here is mirrored or cached — the layout store owns layout
 * and focus, and this only reports it.
 */

import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useChatStore, findTabByAcpSession } from "@/features/chat/stores/chat-store";
import { getEditorPosition, type EditorPosition } from "@/features/editor/lib/editor-views";
import type { UiActionRequest } from "./types";
import { sourceControlShown } from "@/features/layout/lib/source-control";
import { teamChatShown } from "@/features/layout/lib/team-chat";
import { singletonShown } from "@/features/layout/lib/singleton-surface";

export interface UiTabState {
  id: string;
  type: string;
  title: string;
  /** The split column the tab lives in. */
  group: string;
  /** Whether it is the active tab of its column. */
  active: boolean;
  dirty: boolean;
}

export interface UiState {
  project: {
    name: string;
    path: string;
    /** Whether this is the calling session's own project. UI actions act on
     *  the active project either way (project-scoped, CONTEXT.md). */
    isSessionProject: boolean;
  } | null;
  tabs: UiTabState[];
  /** The focused column's active tab. */
  activeTabId: string | null;
  /** Set when the active tab is an editor; the cursor once its view exists. */
  activeFile: ({ path: string } & Partial<EditorPosition>) | null;
  panels: {
    /** The Files surface tab (the project tree): on screen. */
    files: { visible: boolean };
    /** The team-chat surface tab: on screen. */
    teamChat: { visible: boolean };
    /** The source-control surface tab: on screen, and its section. */
    sourceControl: { visible: boolean; section: string };
    chatSidebar: boolean;
    /** Whether any column is showing a terminal tab. */
    terminalVisible: boolean;
    zen: boolean;
  };
  /** The destination over the columns (ADR-0024), when one is up. */
  destination: { id: string; type: string } | null;
  focusedGroup: string;
  groups: string[];
}

/** The calling session belongs to the active project when its chat tab is in
 *  this view, or when it runs inside the project's folder. */
function isSessionProject(
  request: UiActionRequest,
  projectPath: string,
  tabIds: Set<string>,
): boolean {
  const tabId = findTabByAcpSession(useChatStore.getState().sessions, request.sessionId);
  if (tabId && tabIds.has(tabId)) return true;
  return request.cwd === projectPath || request.cwd.startsWith(`${projectPath}/`);
}

export function buildUiState(request: UiActionRequest): UiState {
  const layout = useLayoutStore.getState();
  const project = useAppStore.getState().currentProject;
  const tabs = layout.tabs.map((t) => {
    const group = t.groupId ?? "main";
    return {
      id: t.id,
      type: t.type,
      title: t.title,
      group,
      active: layout.activeByGroup[group] === t.id,
      dirty: t.dirty,
    };
  });
  const active = layout.tabs.find((t) => t.id === layout.activeTabId);
  const filePath = active?.type === "editor" ? active.data.filePath : undefined;
  const position = active ? getEditorPosition(active.id) : undefined;
  const tabIds = new Set(layout.tabs.map((t) => t.id));
  return {
    project: project
      ? {
          name: project.name,
          path: project.path,
          isSessionProject: isSessionProject(request, project.path, tabIds),
        }
      : null,
    tabs,
    activeTabId: layout.activeTabId,
    activeFile: typeof filePath === "string" ? { path: filePath, ...position } : null,
    panels: {
      files: { visible: singletonShown(layout, "files") },
      teamChat: { visible: teamChatShown(layout) },
      sourceControl: {
        visible: sourceControlShown(layout),
        section: layout.sourceControl.section,
      },
      // The app sidebar, which holds the sessions (the field keeps its name).
      chatSidebar: useProjectStore.getState().sidebarOpen,
      terminalVisible: tabs.some((t) => t.active && t.type === "terminal"),
      zen: layout.zen,
    },
    // The full-page view over the columns, if one is up (ADR-0024).
    destination:
      layout.destination && layout.destinationShown
        ? { id: layout.destination.id, type: layout.destination.type }
        : null,
    focusedGroup: layout.focusedGroupId,
    groups: [...layout.groupOrder],
  };
}
