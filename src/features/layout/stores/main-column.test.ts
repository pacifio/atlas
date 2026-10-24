// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { LAYOUT_TEMPLATES } from "../templates";
import { groupOf, useLayoutStore, type Tab } from "./layout-store";

/**
 * The main column is the session and never shows a tab strip, so a tool that
 * lands in it has no tab and no ×: it hides behind the agent. Every path that
 * moves tabs between columns has to keep tools out of it.
 */

const layout = () => useLayoutStore.getState();
const actions = () => layout().actions;

const tab = (id: string, type: Tab["type"], groupId: string): Tab => ({
  id,
  type,
  title: id,
  closable: true,
  dirty: false,
  data: {},
  groupId,
});

/** Tools (not sessions) sitting in the main column. */
const toolsInMain = () =>
  layout().tabs.filter((t) => groupOf(t) === layout().groupOrder[0] && t.type !== "chat");

beforeEach(() => {
  useLayoutStore.setState({
    tabs: [tab("chat-1", "chat", "main"), tab("term-1", "terminal", "g2")],
    groupOrder: ["main", "g2"],
    activeByGroup: { main: "chat-1", g2: "term-1" },
    focusedGroupId: "main",
    activeTabId: "chat-1",
    surfaces: "shown",
    zen: false,
    zenPrev: null,
  });
});

describe("the main column holds sessions only", () => {
  it("opens a tool asked for in the main column in the surfaces pane", () => {
    actions().addTab(tab("editor:/a.ts", "editor", "main"), "main");
    expect(groupOf(layout().tabs.find((t) => t.id === "editor:/a.ts"))).toBe("g2");
    expect(toolsInMain()).toEqual([]);
  });

  it("opens Usage beside the session, not over it", () => {
    actions().addTab(tab("usage", "usage", "main"), "main");
    expect(layout().activeByGroup.main).toBe("chat-1");
    expect(toolsInMain()).toEqual([]);
  });

  it("hides the only surfaces column instead of folding its tools into main", () => {
    actions().closeGroup("g2");
    expect(layout().groupOrder).toEqual(["main", "g2"]);
    expect(layout().surfaces).toBe("hidden");
    expect(toolsInMain()).toEqual([]);
  });

  it("moves a closed column's tools to the other surfaces column", () => {
    useLayoutStore.setState((s) => ({
      tabs: [...s.tabs, tab("browser-1", "browser", "g3")],
      groupOrder: ["main", "g2", "g3"],
      activeByGroup: { ...s.activeByGroup, g3: "browser-1" },
    }));
    actions().closeGroup("g2");
    expect(layout().groupOrder).toEqual(["main", "g3"]);
    expect(groupOf(layout().tabs.find((t) => t.id === "term-1"))).toBe("g3");
    expect(toolsInMain()).toEqual([]);
  });

  it("collapses an empty surfaces column", () => {
    useLayoutStore.setState({
      tabs: [tab("chat-1", "chat", "main")],
      activeByGroup: { main: "chat-1", g2: null },
    });
    actions().closeGroup("g2");
    expect(layout().groupOrder).toEqual(["main"]);
  });

  it("keeps open tools out of main when a template is applied", () => {
    for (const template of LAYOUT_TEMPLATES) {
      actions().applyLayoutTemplate(template);
      expect(toolsInMain(), template.id).toEqual([]);
    }
  });

  it("opens a session in the main column even when a surfaces column has focus", () => {
    actions().setFocusedGroup("g2");
    actions().addTab(tab("chat-2", "chat", "g2"), "g2");
    expect(groupOf(layout().tabs.find((t) => t.id === "chat-2"))).toBe("main");
    expect(layout().activeByGroup.main).toBe("chat-2");
    expect(layout().activeByGroup.g2).toBe("term-1");
  });

  it("moves a session restored into the surfaces pane back to the main column", () => {
    useLayoutStore.setState((s) => ({
      tabs: [...s.tabs, tab("chat-2", "chat", "g3")],
      groupOrder: ["main", "g2", "g3"],
      activeByGroup: { ...s.activeByGroup, g3: "chat-2" },
      viewsByWs: {},
    }));
    actions().commitProjectView("w");
    actions().loadProjectView("w");
    expect(groupOf(layout().tabs.find((t) => t.id === "chat-2"))).toBe("main");
    // The column it emptied closes; the terminal's column stays.
    expect(layout().groupOrder).toEqual(["main", "g2"]);
  });

  it("hides the parked tools behind a one-column template", () => {
    const focus = LAYOUT_TEMPLATES.find((t) => t.columns.length === 1)!;
    actions().applyLayoutTemplate(focus);
    expect(layout().surfaces).toBe("hidden");
    expect(layout().tabs.some((t) => t.id === "term-1")).toBe(true);
  });
});
