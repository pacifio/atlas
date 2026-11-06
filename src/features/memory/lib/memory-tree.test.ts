// The Memory tab's Tree view: hierarchy, collapse, path and wrap helpers.
import { describe, expect, it } from "vitest";
import type { MemoryGraphData, MemoryNode } from "./memory-graph-types";
import {
  ancestorPath,
  buildMemoryTree,
  elbow,
  initialCollapsed,
  layoutTree,
  leafCount,
  parentMap,
  wrapLabel,
} from "./memory-tree";

const mem = (id: string, kind: string, timestampMs: number): MemoryNode => ({
  id,
  title: id,
  summary: "",
  kind,
  source: "claude",
  snippet: "",
  degree: 0,
  timestampMs,
});
const link = (from: string, to: string) => ({ from, to, weight: 1, kind: "link" });

describe("buildMemoryTree", () => {
  const graph: MemoryGraphData = {
    nodes: [
      mem("u1", "user", 1),
      mem("p1", "project", 10),
      mem("p2", "project", 20),
      mem("p3", "project", 30),
    ],
    edges: [link("p1", "p3"), { from: "p1", to: "p2", weight: 0.9, kind: "similarity" }],
  };
  const tree = buildMemoryTree(graph, "acme");

  it("roots at `root` with categories in display order", () => {
    expect(tree.id).toBe("root");
    expect(tree.label).toBe("acme");
    expect(tree.children.map((c) => c.id)).toEqual(["cat:project", "cat:user"]);
  });

  it("nests a wikilinked memory under its link parent, not a similarity one", () => {
    const project = tree.children[0];
    expect(project.children.map((c) => c.id).sort()).toEqual(["p1", "p2"]);
    const p1 = project.children.find((c) => c.id === "p1")!;
    expect(p1.children.map((c) => c.id)).toEqual(["p3"]);
    expect(p1.children[0].depth).toBe(3);
  });

  it("orders a memory's children newest first", () => {
    const g: MemoryGraphData = {
      nodes: [mem("a", "project", 1), mem("b", "project", 2), mem("c", "project", 3)],
      edges: [link("a", "b"), link("a", "c")],
    };
    const a = buildMemoryTree(g, "x").children[0].children[0];
    expect(a.children.map((c) => c.id)).toEqual(["c", "b"]);
  });

  it("a link cycle falls back to the category", () => {
    const g: MemoryGraphData = {
      nodes: [mem("a", "project", 1), mem("b", "project", 1)],
      edges: [link("a", "b"), link("b", "a")],
    };
    // Both point at each other; the walk breaks the loop at the first node it
    // checks (`b`), which then hangs under its category with `a` below it.
    const cat = buildMemoryTree(g, "x").children[0];
    expect(cat.children.map((c) => c.id)).toEqual(["b"]);
    expect(cat.children[0].children.map((c) => c.id)).toEqual(["a"]);
    expect(leafCount(cat)).toBe(1);
  });
});

describe("collapse and path", () => {
  const many = (n: number, kind: string) =>
    Array.from({ length: n }, (_, i) => mem(`${kind}${i}`, kind, i + 1));
  const tree = buildMemoryTree(
    { nodes: [...many(18, "user"), ...many(19, "project")], edges: [] },
    "x",
  );

  it("collapses only categories over 18 leaves", () => {
    expect(initialCollapsed(tree)).toEqual(new Set(["cat:project"]));
  });

  it("walks a memory's path up to the root", () => {
    const t = buildMemoryTree(
      {
        nodes: [mem("a", "project", 1), mem("b", "project", 2)],
        edges: [link("a", "b")],
      },
      "x",
    );
    const parents = parentMap(t);
    expect(parents.get("b")).toBe("a");
    expect(ancestorPath(parents, "b")).toEqual(new Set(["b", "a", "cat:project", "root"]));
  });
});

describe("layoutTree", () => {
  const tree = buildMemoryTree(
    { nodes: [mem("a", "project", 2), mem("b", "project", 1), mem("c", "user", 1)], edges: [] },
    "x",
  );

  it("puts leaves on sequential rows and centres a parent on its children", () => {
    const l = layoutTree(tree, new Set());
    const y = (id: string) => l.positions.get(id)!.y;
    const leaves = ["a", "b", "c"].map(y).sort((p, q) => p - q);
    expect(leaves[1] - leaves[0]).toBe(leaves[2] - leaves[1]);
    expect(y("cat:project")).toBe((y("a") + y("b")) / 2);
  });

  it("a collapsed subtree is one row", () => {
    const open = layoutTree(tree, new Set());
    const shut = layoutTree(tree, new Set(["cat:project"]));
    expect(shut.visible.map((v) => v.id)).not.toContain("a");
    expect(open.height - shut.height).toBe(open.height / 3);
  });
});

describe("wrapLabel", () => {
  it("fits on one line", () => {
    expect(wrapLabel("short label", 20)).toEqual(["short label"]);
  });
  it("wraps to two lines", () => {
    expect(wrapLabel("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
  });
  it("ellipsises when truncated", () => {
    const out = wrapLabel("one two three four five six", 9);
    expect(out).toHaveLength(2);
    expect(out[1].endsWith("…")).toBe(true);
  });
  it("honours maxLines = 3", () => {
    expect(wrapLabel("aa bb cc dd", 2, 3)).toEqual(["aa", "bb", "c…"]);
  });
});

describe("elbow", () => {
  it("keeps the control length at least 24", () => {
    expect(elbow(0, 0, 10, 10)).toBe("M 0 0 C 24 0, -14 10, 10 10");
  });
});
