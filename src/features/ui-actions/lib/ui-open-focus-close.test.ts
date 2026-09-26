// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The settings store subscribes to config events when it loads.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

const invokeMock = vi.hoisted(() =>
  vi.fn(async (cmd: string, _args?: unknown): Promise<unknown> => {
    if (cmd === "threads_projects")
      return [
        {
          name: "atlas",
          paths: ["/p"],
          isCurrent: true,
          threads: [
            {
              threadId: "t-9",
              sessionId: "sess-9",
              agentId: "atlas-agent",
              title: "Older chat",
              updatedAt: "",
              createdAt: null,
              archived: false,
              projectName: "atlas",
              folderPaths: ["/p"],
            },
          ],
        },
      ];
    if (cmd === "spaces_summary") {
      if ((_args as { convId: string }).convId !== "c-design") throw "Space not found";
      const row = (id: string, kind: "page" | "folder", name: string) => ({
        id,
        kind,
        name,
        icon: null,
        parent_id: null,
        sort: 0,
        created_at: 0,
        updated_at: 0,
      });
      return {
        protocol: 1,
        doc_version: 1,
        space_id: "sp-1",
        conv_id: "c-design",
        pages: [row("p-arch", "page", "Architecture"), row("f-docs", "folder", "Docs")],
        active_page_id: null,
        archived: false,
      };
    }
    if (
      cmd === "file_mtime_ms" &&
      String((_args as { path?: string })?.path).includes("only-at-root")
    ) {
      if (String((_args as { path: string }).path).startsWith("/p/pkg/"))
        throw new Error("not found");
    }
    return false;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useEditorStore } from "@/features/editor/stores/editor-store";
import { useSettingsNav } from "@/features/settings/stores/settings-nav-store";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { useSpacesStore } from "@/features/spaces/stores/spaces-store";
import { performUiAction } from "./ui-actions";
import { seedWindow, tab, uiRequest } from "./test-fixtures";
import type { UiActionReply } from "./types";

const layout = () => useLayoutStore.getState();
const result = (reply: UiActionReply) => {
  if (!reply.ok) throw new Error(`expected ok, got: ${reply.error}`);
  return reply.result as Record<string, unknown>;
};
const error = (reply: UiActionReply) => {
  if (reply.ok) throw new Error(`expected a refusal, got ${JSON.stringify(reply.result)}`);
  return reply.error;
};
const act = (tool: string, args: Record<string, unknown>) => performUiAction(uiRequest(tool, args));

beforeEach(() => {
  seedWindow();
  useEditorStore.setState({ buffers: {}, activeBufferPath: null, pendingReveals: {} });
  useProjectStore.setState({
    projects: [
      { id: "w-1", name: "atlas", path: "/p" },
      { id: "w-2", name: "website", path: "/w" },
    ] as never,
    activeProjectId: "w-1",
  });
  useLayoutStore.setState({
    currentViewWsId: "w-1",
    viewsByWs: { "w-2": { tabs: [tab("chat-w", "chat")] } as never },
  });
});

describe("ui_open", () => {
  it("opens a project-relative file at a line in the one editor tab for it", async () => {
    const r = result(
      await act("ui_open", { target: "file", path: "src/main.ts", line: 200, column: 3 }),
    );
    expect(r.tabId).toBe("editor:/p/src/main.ts");
    expect(layout().activeTabId).toBe("editor:/p/src/main.ts");
    expect(useEditorStore.getState().pendingReveals["/p/src/main.ts"]).toMatchObject({
      line: 200,
      column: 3,
    });
  });

  /// The agent thinks in its own working directory, which can be a worktree
  /// or subfolder of the project.
  it("resolves a relative path against the session's cwd first", async () => {
    const reply = await performUiAction({
      ...uiRequest("ui_open", { target: "file", path: "a.ts" }),
      cwd: "/p/pkg",
    });
    expect(result(reply).tabId).toBe("editor:/p/pkg/a.ts");
  });

  it("falls back to the project when the file is not under the session's cwd", async () => {
    const reply = await performUiAction({
      ...uiRequest("ui_open", { target: "file", path: "src/only-at-root.ts" }),
      cwd: "/p/pkg",
    });
    expect(result(reply).tabId).toBe("editor:/p/src/only-at-root.ts");
  });

  it("opens a git diff of a file relative to the session's cwd", async () => {
    const reply = await performUiAction({
      ...uiRequest("ui_open", { target: "diff", path: "a.ts" }),
      cwd: "/p/pkg",
    });
    expect(result(reply)).toMatchObject({ repoPath: "/p", file: "pkg/a.ts" });
  });

  it("opens a new chat", async () => {
    const before = layout().tabs.filter((t) => t.type === "chat").length;
    const r = result(await act("ui_open", { target: "new_chat" }));
    expect(layout().tabs.find((t) => t.id === r.tabId)?.type).toBe("chat");
    expect(layout().tabs.filter((t) => t.type === "chat").length).toBeGreaterThanOrEqual(before);
  });

  it("opens a git diff of a file", async () => {
    const r = result(await act("ui_open", { target: "diff", path: "src/main.ts", staged: true }));
    expect(r.tabId).toBe("diff:src/main.ts:s");
    expect(layout().tabs.find((t) => t.id === r.tabId)?.data).toMatchObject({
      repoPath: "/p",
      staged: true,
    });
  });

  it("opens settings on a section and rejects one that does not exist", async () => {
    const r = result(await act("ui_open", { target: "settings", section: "keybindings" }));
    expect(layout().tabs.find((t) => t.id === r.tabId)?.type).toBe("settings");
    expect(useSettingsNav.getState().section).toBe("keybindings");
    expect(error(await act("ui_open", { target: "settings", section: "secrets" }))).toMatch(
      /keybindings/,
    );
  });

  it("opens a singleton tab type once per column", async () => {
    const first = result(await act("ui_open", { target: "tab", type: "log" })).tabId;
    const again = result(await act("ui_open", { target: "tab", type: "log" })).tabId;
    expect(again).toBe(first);
    expect(layout().tabs.filter((t) => t.type === "log")).toHaveLength(1);
    expect(error(await act("ui_open", { target: "tab", type: "editor" }))).toMatch(/file/);
  });

  it("opens the Timeline at a session", async () => {
    result(await act("ui_open", { target: "timeline", sessionId: "cap-1" }));
    expect(layout().tabs.find((t) => t.type === "artifacts")).toBeDefined();
    expect(useArtifactsStore.getState().open).toMatchObject({
      sessionId: "cap-1",
      projectPath: "/p",
    });
  });

  it("opens a knowledge note", async () => {
    result(await act("ui_open", { target: "knowledge", noteId: "note-3" }));
    expect(layout().tabs.find((t) => t.type === "knowledge")).toBeDefined();
    expect(useKnowledgeStore.getState().pendingOpenId).toBe("note-3");
  });

  it("navigates an existing browser tab instead of opening a second", async () => {
    const heard = vi.fn();
    window.addEventListener("atlas:browser-navigate", heard);
    const first = result(await act("ui_open", { target: "url", url: "https://a.dev" })).tabId;
    const second = result(await act("ui_open", { target: "url", url: "https://b.dev" })).tabId;
    expect(second).toBe(first);
    expect(layout().tabs.filter((t) => t.type === "browser")).toHaveLength(1);
    expect(heard).toHaveBeenCalledOnce();
    expect((heard.mock.calls[0][0] as CustomEvent).detail).toEqual({
      tabId: first,
      url: "https://b.dev",
    });
    window.removeEventListener("atlas:browser-navigate", heard);
  });

  it("focuses a thread whose chat is already open", async () => {
    expect(result(await act("ui_open", { target: "thread", sessionId: "sess-1" })).tabId).toBe(
      "chat-1",
    );
    expect(layout().activeTabId).toBe("chat-1");
  });

  it("refuses a thread that is not in the active project's history", async () => {
    expect(error(await act("ui_open", { target: "thread", sessionId: "sess-nope" }))).toMatch(
      /atlas/,
    );
  });

  it("opens a conversation's Space on a page, through the Space tab the conversation opens", async () => {
    useCommsStore.setState({
      conversations: [
        { id: "c-design", kind: "channel", name: "design", member_ids: null },
      ] as never,
    });
    const opened = result(
      await act("ui_open", { target: "space_page", conversationId: "c-design", pageId: "p-arch" }),
    );
    expect(opened).toEqual({
      tabId: "spaces-c-design",
      conversationId: "c-design",
      pageId: "p-arch",
      page: "Architecture",
    });
    const tab = layout().tabs.find((t) => t.id === "spaces-c-design");
    expect(tab).toMatchObject({
      type: "spaces",
      title: "design — Space",
      data: { convId: "c-design" },
    });
    expect(layout().activeTabId).toBe("spaces-c-design");
    expect(useSpacesStore.getState().requestedPages["c-design"]).toBe("p-arch");

    // Asked again, the same tab is refocused, not a second one opened.
    result(
      await act("ui_open", { target: "space_page", conversationId: "c-design", pageId: "p-arch" }),
    );
    expect(layout().tabs.filter((t) => t.type === "spaces")).toHaveLength(1);
  });

  it("refuses a Space page that is not there, naming what is missing", async () => {
    useCommsStore.setState({
      conversations: [
        { id: "c-design", kind: "channel", name: "design", member_ids: null },
      ] as never,
    });
    const open = (conversationId: string, pageId: string) =>
      act("ui_open", { target: "space_page", conversationId, pageId });
    expect(error(await open("c-gone", "p-arch"))).toMatch(/no conversation c-gone/);
    expect(error(await open("c-design", "p-nope"))).toMatch(/no page p-nope/);
    expect(error(await open("c-design", "f-docs"))).toMatch(/"Docs" is a folder/);
    expect(
      error(await act("ui_open", { target: "space_page", conversationId: "c-design" })),
    ).toMatch(/pageId/);
    expect(layout().tabs.some((t) => t.type === "spaces")).toBe(false);
  });

  it("has no project target: UI actions never switch projects", async () => {
    expect(error(await act("ui_open", { target: "project", path: "/w" }))).toMatch(
      /unknown target/,
    );
  });

  it("names the shape it wanted when the arguments are wrong", async () => {
    expect(error(await act("ui_open", {}))).toMatch(/target/);
    expect(error(await act("ui_open", { target: "file" }))).toMatch(/path/);
    expect(error(await act("ui_open", { target: "file", path: "a.ts", line: "ten" }))).toMatch(
      /line/,
    );
  });
});

describe("ui_focus", () => {
  it("activates a tab in the active project", async () => {
    result(await act("ui_focus", { target: "tab", id: "chat-1" }));
    expect(layout().activeTabId).toBe("chat-1");
  });

  it("refuses a tab another project owns, naming the project", async () => {
    expect(error(await act("ui_focus", { target: "tab", id: "chat-w" }))).toMatch(/website/);
  });

  it("shows, hides or toggles a panel", async () => {
    result(await act("ui_focus", { target: "panel", name: "right", visible: true }));
    expect(layout().rightPanel.visible).toBe(true);
    result(await act("ui_focus", { target: "panel", name: "right", visible: true }));
    expect(layout().rightPanel.visible).toBe(true);
    result(await act("ui_focus", { target: "panel", name: "left" }));
    expect(layout().leftPanel.visible).toBe(false);
    result(await act("ui_focus", { target: "panel", name: "chat_sidebar", visible: false }));
    expect(layout().chatSidebar.visible).toBe(false);
  });

  it("reveals a side panel section", async () => {
    result(await act("ui_focus", { target: "section", side: "right", section: "git-graph" }));
    expect(layout().rightPanel).toMatchObject({
      visible: true,
      activeSection: "git-graph",
      mode: "source-control",
    });
    useLayoutStore.setState({ leftPanel: { ...layout().leftPanel, visible: false } });
    result(await act("ui_focus", { target: "section", side: "left", section: "knowledge" }));
    expect(layout().leftPanel).toMatchObject({ visible: true, activeSection: "knowledge" });
    expect(
      error(await act("ui_focus", { target: "section", side: "left", section: "changes" })),
    ).toMatch(/files/);
  });

  it("switches the right panel's mode and keeps it open", async () => {
    result(await act("ui_focus", { target: "right_mode", mode: "chat" }));
    expect(layout().rightPanel).toMatchObject({ visible: true, mode: "chat" });
    result(await act("ui_focus", { target: "right_mode", mode: "chat" }));
    expect(layout().rightPanel.visible).toBe(true);
  });

  it("reveals a path in the explorer, opening the Files panel", async () => {
    useLayoutStore.setState({
      leftPanel: { ...layout().leftPanel, visible: false, activeSection: "knowledge" },
    });
    const { useExplorerStore } = await import("@/features/explorer/stores/explorer-store");
    result(await act("ui_focus", { target: "explorer", path: "src/App.tsx" }));
    expect(layout().leftPanel).toMatchObject({ visible: true, activeSection: "files" });
    expect(useExplorerStore.getState().selectedPaths).toEqual(["/p/src/App.tsx"]);
    expect(error(await act("ui_focus", { target: "explorer", path: "/etc/hosts" }))).toMatch(
      /outside/,
    );
  });

  it("toggles the terminal through the app's own terminal command", async () => {
    const { registerActionHandlers } = await import("@/features/keybindings/lib/action-registry");
    const toggle = vi.fn();
    const drop = registerActionHandlers(() => ({ "panels.terminal": toggle }));
    // The seeded window already shows a terminal in its second column.
    result(await act("ui_focus", { target: "panel", name: "terminal", visible: true }));
    expect(toggle).not.toHaveBeenCalled();
    result(await act("ui_focus", { target: "panel", name: "terminal", visible: false }));
    expect(toggle).toHaveBeenCalledOnce();
    drop();
  });

  it("focuses a split column by its index in ui_state's groups", async () => {
    result(await act("ui_focus", { target: "group", index: 1 }));
    expect(layout().focusedGroupId).toBe("g2");
    expect(error(await act("ui_focus", { target: "group", index: 5 }))).toMatch(/2 columns/);
  });
});

describe("ui_close", () => {
  it("closes a tab and defaults to the active one", async () => {
    expect(result(await act("ui_close", { tabId: "terminal-1" }))).toMatchObject({ closed: true });
    expect(layout().tabs.some((t) => t.id === "terminal-1")).toBe(false);
    expect(result(await act("ui_close", {}))).toMatchObject({
      tabId: "editor:/p/src/App.tsx",
      closed: true,
    });
  });

  /// Own-session refusal's sibling: closing unsaved work is the user's call.
  it("refuses to close an editor with unsaved changes", async () => {
    useEditorStore.setState({
      buffers: { "/p/src/App.tsx": { path: "/p/src/App.tsx", dirty: true } as never },
    });
    expect(error(await act("ui_close", { tabId: "editor:/p/src/App.tsx" }))).toMatch(/unsaved/);
    expect(layout().tabs.some((t) => t.id === "editor:/p/src/App.tsx")).toBe(true);
  });

  it("refuses a tab another project owns", async () => {
    expect(error(await act("ui_close", { tabId: "chat-w" }))).toMatch(/website/);
  });

  it("leaves a busy chat to the user's confirmation", async () => {
    const { useChatStore } = await import("@/features/chat/stores/chat-store");
    useChatStore.setState({
      sessions: { "chat-1": { acpSessionId: "sess-1", status: "running" } } as never,
    });
    expect(result(await act("ui_close", { tabId: "chat-1" }))).toEqual({
      tabId: "chat-1",
      closed: false,
      awaitingUserConfirm: true,
    });
  });

  it("refuses a tab that does not exist", async () => {
    expect(error(await act("ui_close", { tabId: "nope" }))).toMatch(/no tab/);
  });
});
