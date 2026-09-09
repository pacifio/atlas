import { beforeEach, describe, expect, it } from "vitest";
import { collectPanes, findTerminal, useTerminalStore, type SplitNode } from "./terminal-store";

beforeEach(() =>
  useTerminalStore.setState({ tabs: {}, busy: {}, pendingCommands: {}, owners: {} }),
);

const s = () => useTerminalStore.getState();

describe("terminal pane trees", () => {
  it("records the owner on init and drops it with the tab", () => {
    s().actions.initTab("t1", "ws-a");
    expect(s().owners.t1).toBe("ws-a");
    s().actions.removeTabs(["t1"]);
    expect(s().owners.t1).toBeUndefined();
    expect(s().tabs.t1).toBeUndefined();
  });

  it("finds a terminal's tab and pane", () => {
    s().actions.initTab("t1", "ws-a");
    const root = s().tabs.t1.root;
    const id = (root as { terminals: string[] }).terminals[0];
    expect(findTerminal(s().tabs, id)).toEqual({ tabId: "t1", paneId: root.id });
    expect(findTerminal(s().tabs, "nope")).toBeNull();
  });

  it("split sizes persist and renormalise when a child closes", () => {
    s().actions.initTab("t1", "ws-a");
    const paneA = s().tabs.t1.root.id;
    s().actions.splitPane("t1", paneA, "horizontal");
    const split = s().tabs.t1.root as SplitNode;
    expect(split.type).toBe("split");
    const [a, b] = split.children.map((c) => c.id);
    s().actions.setSplitSizes("t1", split.id, { [a]: 30, [b]: 70 });
    expect((s().tabs.t1.root as SplitNode).sizes).toEqual({ [a]: 30, [b]: 70 });
    // Split b again, then close a: the remaining split keeps proportions summing to 100.
    s().actions.splitPane("t1", b, "vertical");
    const outer = s().tabs.t1.root as SplitNode;
    s().actions.setSplitSizes("t1", outer.id, {
      [outer.children[0].id]: 25,
      [outer.children[1].id]: 75,
    });
    s().actions.closePane("t1", a);
    const root = s().tabs.t1.root as SplitNode;
    expect(root.type).toBe("split");
    expect(collectPanes(root)).toHaveLength(2);
  });

  it("export → import round-trips structure and sizes with fresh ids", () => {
    s().actions.initTab("t1", "ws-a");
    const paneA = s().tabs.t1.root.id;
    s().actions.splitPane("t1", paneA, "horizontal");
    const split = s().tabs.t1.root as SplitNode;
    const [a, b] = split.children.map((c) => c.id);
    s().actions.setSplitSizes("t1", split.id, { [a]: 40, [b]: 60 });
    const exported = s().actions.exportTrees(["t1"]);
    const oldIds = new Set([split.id, a, b, ...collectPanes(split).flatMap((p) => p.terminals)]);

    useTerminalStore.setState({ tabs: {}, busy: {}, pendingCommands: {}, owners: {} });
    s().actions.importTrees(exported);
    const restored = s().tabs.t1.root as SplitNode;
    expect(restored.type).toBe("split");
    expect(restored.direction).toBe("horizontal");
    const [ra, rb] = restored.children.map((c) => c.id);
    expect(restored.sizes).toEqual({ [ra]: 40, [rb]: 60 });
    const newIds = [restored.id, ra, rb, ...collectPanes(restored).flatMap((p) => p.terminals)];
    for (const id of newIds) expect(oldIds.has(id)).toBe(false);
    expect(s().tabs.t1.activePaneId).toBe(collectPanes(restored)[0].id);
  });

  it("import skips tabs that already exist", () => {
    s().actions.initTab("t1", "ws-a");
    const before = s().tabs.t1;
    s().actions.importTrees({ t1: before });
    expect(s().tabs.t1).toBe(before);
  });

  it("zoom toggles and is cleared by structural changes", () => {
    s().actions.initTab("t1", "ws-a");
    const paneA = s().tabs.t1.root.id;
    s().actions.splitPane("t1", paneA, "horizontal");
    const [, b] = collectPanes(s().tabs.t1.root).map((p) => p.id);
    s().actions.toggleZoom("t1", b);
    expect(s().tabs.t1.zoomedPaneId).toBe(b);
    s().actions.toggleZoom("t1", b);
    expect(s().tabs.t1.zoomedPaneId).toBeNull();
    s().actions.toggleZoom("t1", b);
    s().actions.closePane("t1", paneA);
    expect(s().tabs.t1.zoomedPaneId).toBeNull();
  });
});
