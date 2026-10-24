import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore, type Tab } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import type { UiActionRequest } from "./types";

export function tab(
  id: string,
  type: Tab["type"],
  groupId = "main",
  extra: Partial<Tab> = {},
): Tab {
  return { id, type, title: id, closable: true, dirty: false, data: {}, groupId, ...extra };
}

/** A project with an editor and a chat in the main column, a terminal in a
 *  second column focused. */
export function seedWindow() {
  useAppStore.setState({ currentProject: { name: "atlas", path: "/p" } });
  useLayoutStore.setState({
    tabs: [
      tab("editor:/p/src/App.tsx", "editor", "main", {
        title: "App.tsx",
        data: { filePath: "/p/src/App.tsx" },
      }),
      tab("chat-1", "chat", "main", { title: "Chat" }),
      tab("terminal-1", "terminal", "g2", { title: "Terminal" }),
    ],
    groupOrder: ["main", "g2"],
    activeByGroup: { main: "editor:/p/src/App.tsx", g2: "terminal-1" },
    focusedGroupId: "main",
    activeTabId: "editor:/p/src/App.tsx",
    sourceControl: { section: "changes" },
    zen: false,
    destination: null,
    destinationShown: false,
  });
  useProjectStore.setState({ sidebarOpen: true });
  useChatStore.setState({
    sessions: { "chat-1": { acpSessionId: "sess-1" } } as never,
    activeSessionId: "chat-1",
  });
}

export function uiRequest(
  tool: string,
  args: Record<string, unknown> = {},
  sessionId = "sess-1",
): UiActionRequest {
  return { requestId: "r-1", sessionId, agent: "atlas-agent", cwd: "/p", tool, args };
}
