// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { groupOf, restoredTabType, useLayoutStore, type Tab } from "./layout-store";
import { destinationShown, toggleDestination } from "../lib/destinations";

/**
 * Destinations (ADR-0024) take the area right of the rail, one at a time, and
 * never enter a column, whichever path opens them.
 */

const layout = () => useLayoutStore.getState();
const actions = () => layout().actions;

const tab = (id: string, type: Tab["type"], groupId?: string, data = {}): Tab => ({
  id,
  type,
  title: id,
  closable: true,
  dirty: false,
  data,
  groupId,
});

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
    destination: null,
    destinationShown: false,
  });
});

describe("destinations", () => {
  it("opens over the columns, never as a column's tab", () => {
    actions().addTab(tab("knowledge-1", "knowledge"), "g2");
    expect(layout().destination?.type).toBe("knowledge");
    expect(layout().destinationShown).toBe(true);
    expect(layout().tabs.some((t) => t.type === "knowledge")).toBe(false);
    expect(layout().activeByGroup.g2).toBe("term-1");
  });

  it("shows one at a time: opening another replaces it", () => {
    actions().addTab(tab("usage", "usage"));
    actions().addTab(tab("artifacts", "artifacts"));
    expect(layout().destination?.type).toBe("artifacts");
  });

  it("reopens the same kind in place, keeping its mounted id", () => {
    actions().addTab(tab("knowledge-1", "knowledge"));
    actions().hideDestination();
    actions().addTab(tab("knowledge-2", "knowledge"));
    expect(layout().destination?.id).toBe("knowledge-1");
    expect(layout().destinationShown).toBe(true);
  });

  it("gives each conversation's Space its own page", () => {
    actions().addTab(tab("spaces-a", "spaces", undefined, { convId: "a" }));
    actions().addTab(tab("spaces-b", "spaces", undefined, { convId: "b" }));
    expect(layout().destination).toMatchObject({ id: "spaces-b", data: { convId: "b" } });
  });

  it("goes back to the session when a session or surface is focused or opened", () => {
    actions().addTab(tab("memory", "memory"));
    actions().setActiveTab("term-1");
    expect(layout().destinationShown).toBe(false);
    expect(layout().destination?.type).toBe("memory");

    actions().setActiveTab("memory");
    expect(layout().destinationShown).toBe(true);
    actions().addTab(tab("editor:/a.ts", "editor"));
    expect(layout().destinationShown).toBe(false);
  });

  it("toggles from its own entry point", () => {
    toggleDestination("usage");
    expect(destinationShown(layout(), "usage")).toBe(true);
    toggleDestination("usage");
    expect(destinationShown(layout(), "usage")).toBe(false);
    toggleDestination("usage");
    expect(destinationShown(layout(), "usage")).toBe(true);
  });

  it("closes outright through closeTab", () => {
    actions().addTab(tab("usage", "usage"));
    actions().closeTab("usage");
    expect(layout().destination).toBeNull();
    expect(layout().destinationShown).toBe(false);
  });

  it("is not restored as a column tab from a saved project layout", () => {
    for (const type of ["knowledge", "artifacts", "memory", "canvas", "knowledge-graph"]) {
      expect(restoredTabType(type), type).toBeNull();
    }
    expect(restoredTabType("editor")).toBe("editor");
  });

  it("drops destination tabs from a project view on load", () => {
    useLayoutStore.setState((s) => ({
      viewsByWs: {
        ...s.viewsByWs,
        w1: {
          tabs: [tab("chat-w", "chat", "main"), tab("knowledge-old", "knowledge", "g9")],
          activeTabId: "knowledge-old",
          groupOrder: ["main", "g9"],
          activeByGroup: { main: "chat-w", g9: "knowledge-old" },
          focusedGroupId: "g9",
          tabHistory: [],
          tabHistoryIndex: 0,
        },
      },
    }));
    actions().loadProjectView("w1");
    expect(layout().tabs.some((t) => t.type === "knowledge")).toBe(false);
    for (const t of layout().tabs) expect(layout().groupOrder).toContain(groupOf(t));
  });
});
