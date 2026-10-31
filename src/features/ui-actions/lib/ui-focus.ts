/**
 * `ui_focus`: activate a tab, show or hide a panel, pick source control's
 * section, focus a split column, or reveal a path in the Files surface (the
 * project tree). Always through the layout store's own actions.
 */

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import {
  revealSourceControl,
  sourceControlShown,
  toggleSourceControl,
} from "@/features/layout/lib/source-control";
import { teamChatShown, toggleTeamChat } from "@/features/layout/lib/team-chat";
import { FILES_TAB, revealFiles, toggleFiles } from "@/features/layout/lib/files-surface";
import { singletonShown } from "@/features/layout/lib/singleton-surface";
import { runAction } from "@/features/keybindings/lib/action-registry";
import { readArgs, refuse } from "./args";
import { activeProject, resolvePath, tabInScope } from "./scope";
import type { UiActionRequest } from "./types";

const TARGETS = ["tab", "panel", "section", "group", "explorer"] as const;
const PANELS = [
  "files",
  "team_chat",
  "source_control",
  "chat_sidebar",
  "terminal",
  "timeline_sidebar",
] as const;
type Panel = (typeof PANELS)[number];

const layout = () => useLayoutStore.getState();

function panelVisible(name: Panel): boolean {
  const s = layout();
  switch (name) {
    case "files":
      return singletonShown(s, FILES_TAB.type);
    case "team_chat":
      return teamChatShown(s);
    case "source_control":
      return sourceControlShown(s);
    // The name predates the one app sidebar, where the sessions now live;
    // the agent-facing tool keeps it.
    case "chat_sidebar":
      return useProjectStore.getState().sidebarOpen;
    case "timeline_sidebar":
      return s.timelinePanel.showSidebar;
    case "terminal":
      return s.tabs.some(
        (t) => t.type === "terminal" && s.activeByGroup[t.groupId ?? "main"] === t.id,
      );
  }
}

function togglePanel(name: Panel): void {
  const s = layout();
  const a = s.actions;
  switch (name) {
    case "files":
      return toggleFiles();
    case "team_chat":
      return toggleTeamChat();
    case "source_control":
      return toggleSourceControl();
    case "chat_sidebar":
      return useProjectStore.getState().actions.toggleSidebar();
    case "timeline_sidebar":
      return a.toggleTimelineSidebar();
    case "terminal": {
      // The app shell's own terminal toggle, the one ⌃` runs.
      const ran = runAction("panels.terminal");
      if (!ran.ok) refuse("the terminal toggle is not available right now");
      return;
    }
  }
}

export async function performFocus(request: UiActionRequest): Promise<unknown> {
  const a = readArgs("ui_focus", request.args);
  const target = a.oneOf("target", TARGETS);
  const actions = layout().actions;
  switch (target) {
    case "tab": {
      const id = tabInScope(a.str("id")).id;
      actions.setActiveTab(id);
      return { tabId: id };
    }
    case "panel": {
      const name = a.oneOf("name", PANELS);
      const wanted = a.optBool("visible") ?? !panelVisible(name);
      if (panelVisible(name) !== wanted) togglePanel(name);
      return { panel: name, visible: panelVisible(name) };
    }
    case "section": {
      const side = a.oneOf("side", ["source_control"] as const);
      const section = a.oneOf("section", ["changes", "github", "git-graph"] as const);
      revealSourceControl(section);
      return { side, section };
    }
    case "group": {
      const index = a.optInt("index", 0) ?? refuse("ui_focus: index must be an integer ≥ 0");
      const groups = layout().groupOrder;
      const group =
        groups[index] ??
        refuse(
          `ui_focus: index ${index} is out of range; the window has ${groups.length} columns (0-based)`,
        );
      actions.setFocusedGroup(group);
      return { group, index };
    }
    case "explorer":
      return revealInExplorer(await resolvePath(a.str("path"), request.cwd));
  }
}

/** Show the Files surface, open every folder down to `path`, and highlight it. */
function revealInExplorer(path: string): unknown {
  const root = activeProject().path;
  if (path !== root && !path.startsWith(`${root}/`))
    return refuse(`${path} is outside the active project`);
  revealFiles(path);
  return { path };
}
