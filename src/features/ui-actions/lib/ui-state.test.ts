// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The settings store subscribes to config events when it loads.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { positionOfSelection, registerEditorView } from "@/features/editor/lib/editor-views";
import { buildUiState } from "./ui-state";
import { seedWindow, tab, uiRequest } from "./test-fixtures";

beforeEach(seedWindow);

describe("buildUiState", () => {
  it("reports the project, every tab with its column, and what is active", () => {
    const state = buildUiState(uiRequest("ui_state"));
    expect(state.project).toEqual({ name: "atlas", path: "/p", isSessionProject: true });
    expect(state.tabs).toEqual([
      {
        id: "editor:/p/src/App.tsx",
        type: "editor",
        title: "App.tsx",
        group: "main",
        active: true,
        dirty: false,
      },
      { id: "chat-1", type: "chat", title: "Chat", group: "main", active: false, dirty: false },
      {
        id: "terminal-1",
        type: "terminal",
        title: "Terminal",
        group: "g2",
        active: true,
        dirty: false,
      },
    ]);
    expect(state.activeTabId).toBe("editor:/p/src/App.tsx");
    expect(state.focusedGroup).toBe("main");
    expect(state.groups).toEqual(["main", "g2"]);
  });

  it("reports the panels", () => {
    expect(buildUiState(uiRequest("ui_state")).panels).toEqual({
      files: { visible: false },
      teamChat: { visible: false },
      sourceControl: { visible: false, section: "changes" },
      chatSidebar: true,
      terminalVisible: true,
      zen: false,
    });
  });

  it("reports the active editor's file", () => {
    expect(buildUiState(uiRequest("ui_state")).activeFile).toEqual({ path: "/p/src/App.tsx" });
  });

  it("reports the active editor's cursor and selection, 1-based", () => {
    const drop = registerEditorView("editor:/p/src/App.tsx", () =>
      positionOfSelection({
        start: { line: 1, character: 0 },
        end: { line: 1, character: 2 },
        direction: 1,
      }),
    );
    expect(buildUiState(uiRequest("ui_state")).activeFile).toEqual({
      path: "/p/src/App.tsx",
      cursor: { line: 2, col: 3 },
      selection: { from: { line: 2, col: 1 }, to: { line: 2, col: 3 } },
    });
    drop();
  });

  it("says whether the active project is the calling session's own", () => {
    expect(buildUiState(uiRequest("ui_state")).project?.isSessionProject).toBe(true);
    const elsewhere = { ...uiRequest("ui_state", {}, "sess-other"), cwd: "/elsewhere" };
    expect(buildUiState(elsewhere).project?.isSessionProject).toBe(false);
  });

  it("has no active file when the active tab is not an editor", () => {
    useLayoutStore.setState({
      activeTabId: "chat-1",
      activeByGroup: { main: "chat-1", g2: "terminal-1" },
    });
    expect(buildUiState(uiRequest("ui_state")).activeFile).toBeNull();
  });

  it("reports no terminal when no column shows one", () => {
    useLayoutStore.setState({
      tabs: [tab("chat-1", "chat")],
      groupOrder: ["main"],
      activeByGroup: { main: "chat-1" },
    });
    expect(buildUiState(uiRequest("ui_state")).panels.terminalVisible).toBe(false);
  });

  it("copes with no project open", () => {
    useAppStore.setState({ currentProject: null });
    expect(buildUiState(uiRequest("ui_state")).project).toBeNull();
  });
});
