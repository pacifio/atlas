// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { navigationTabs, useLayoutStore, type Tab } from "./layout-store";
import { tabNavigationActions } from "@/features/keybindings/lib/navigation-hints";

const tab = (id: string, type: Tab["type"], groupId = "main"): Tab => ({
  id,
  title: id,
  type,
  groupId,
  closable: true,
  dirty: false,
  data: {},
});
const mixed = [
  tab("chat", "chat"),
  tab("settings", "settings"),
  tab("terminal", "terminal"),
  tab("usage", "usage", "right"),
  tab("file", "editor", "right"),
];
const actions = () => useLayoutStore.getState().actions;
const active = () => useLayoutStore.getState().activeTabId;

beforeEach(() => {
  useLayoutStore.setState({
    ...useLayoutStore.getInitialState(),
    tabs: mixed,
    groupOrder: ["main", "right"],
    focusedGroupId: "main",
    activeByGroup: { main: "chat", right: "file" },
    activeTabId: "chat",
  });
});

describe("navigation in the projectless strip", () => {
  it("numbers only the visible tabs, across the flat strip's saved groups", () => {
    const visible = navigationTabs(mixed, "main", true);
    expect(visible.map((t) => t.id)).toEqual(["settings", "usage"]);
    expect(tabNavigationActions(0, visible.length, 0)).toContain("tabs.focus1");
    expect(tabNavigationActions(1, visible.length, 0)).toContain("tabs.focus2");
    expect(tabNavigationActions(1, visible.length, 0)).toContain("tabs.focus9");
  });

  it("dispatches those indices without selecting or deleting hidden project tabs", () => {
    actions().activateTabByIndex(0, true);
    expect(active()).toBe("settings");
    actions().activateTabByIndex(1, true);
    expect(active()).toBe("usage");
    expect(useLayoutStore.getState().focusedGroupId).toBe("right");
    actions().activateTabByIndex(0, true);
    expect(active()).toBe("settings");
    expect(useLayoutStore.getState().tabs).toEqual(mixed);
  });

  it("cycles and selects the last tab using the same visible list", () => {
    actions().activateTabByIndex(0, true);
    actions().cycleTab(-1, true);
    expect(active()).toBe("usage");
    actions().cycleTab(1, true);
    expect(active()).toBe("settings");
    actions().activateTabByIndex(-1, true);
    expect(active()).toBe("usage");
    actions().activateTabByIndex(7, true);
    expect(active()).toBe("usage");
  });

  it("does nothing when the projectless strip has no eligible tabs", () => {
    useLayoutStore.setState({ tabs: [mixed[0]] });
    actions().activateTabByIndex(0, true);
    actions().cycleTab(1, true);
    expect(active()).toBe("chat");
  });

  it("preserves pane-local navigation over all types when a project is open", () => {
    expect(navigationTabs(mixed, "main").map((t) => t.id)).toEqual([
      "chat",
      "settings",
      "terminal",
    ]);
    actions().activateTabByIndex(-1);
    expect(active()).toBe("terminal");
    actions().cycleTab(1);
    expect(active()).toBe("chat");
    expect(useLayoutStore.getState().activeByGroup.right).toBe("file");
  });
});
