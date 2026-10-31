import { describe, expect, it, vi } from "vitest";
import type { DirectoryListing, ProjectEntry } from "./fs-api";
import {
  ancestorsOf,
  BATCH_SIZE,
  chainOwners,
  rowIndexOf,
  dropProjectTreeModel,
  flattenTree,
  MAX_MODELS,
  projectTreeModel,
  ProjectTreeModel,
  refreshProjectTree,
  type DirectoryReader,
} from "./project-tree-model";

/** A fake disk: directory → entries, answered like `read_directories`. */
function disk(tree: Record<string, ProjectEntry[]>) {
  const calls: string[][] = [];
  const read: DirectoryReader = vi.fn(async (_root: string, paths: string[]) => {
    calls.push([...paths]);
    return paths.map((path): DirectoryListing =>
      path in tree ? { path, entries: tree[path] } : { path, entries: [], error: "not found" },
    );
  });
  return { tree, read, calls };
}

const dir = (path: string, ignored?: boolean): ProjectEntry => ({
  path,
  kind: "directory",
  ...(ignored ? { ignored } : {}),
});
const file = (path: string): ProjectEntry => ({ path, kind: "file" });

const TREE: Record<string, ProjectEntry[]> = {
  "": [dir("a"), dir("b"), dir("node_modules", true), file(".env"), file("README.md")],
  a: [dir("a/x"), file("a/one.ts")],
  "a/x": [file("a/x/deep.ts")],
  b: [file("b/two.ts")],
  node_modules: [dir("node_modules/react", true), file("node_modules/main.js")],
  "node_modules/react": [],
};

const paths = (m: ProjectTreeModel) => m.getSnapshot().rows.map((r) => r.path);
const flushed = () => new Promise((r) => setTimeout(r, 0));

describe("projectTreeModel", () => {
  it("keeps one model per root and drops the least recently used past the cap", () => {
    const { read } = disk(TREE);
    const first = projectTreeModel("/r0", read);
    expect(projectTreeModel("/r0", read)).toBe(first);
    for (let i = 1; i <= MAX_MODELS; i++) projectTreeModel(`/r${i}`, read);
    // /r0 was the oldest: asking again builds a new one.
    expect(projectTreeModel("/r0", read)).not.toBe(first);
    for (let i = 0; i <= MAX_MODELS; i++) dropProjectTreeModel(`/r${i}`);
  });

  it("takes the watcher's absolute folders to a cached tree, and never creates one", async () => {
    const { read, calls } = disk(TREE);
    refreshProjectTree("/w", ["/w/a"]);
    await flushed();
    expect(calls).toEqual([]);

    const model = projectTreeModel("/w", read);
    await model.load([""]);
    await model.expand("a");
    calls.length = 0;
    // `/w-other` shares the prefix but is another folder; `/elsewhere` is
    // outside the root. Only the root and `a` are this tree's.
    refreshProjectTree("/w", ["/w", "/w/a", "/w-other/a", "/elsewhere"]);
    await flushed();
    expect(calls).toEqual([["", "a"]]);
    dropProjectTreeModel("/w");
  });
});

describe("ancestorsOf", () => {
  it("lists the root and every folder above a path", () => {
    expect(ancestorsOf("a/b/c.ts")).toEqual(["", "a", "a/b"]);
    expect(ancestorsOf("top.ts")).toEqual([""]);
  });
});

describe("flattenTree", () => {
  it("walks expanded directories depth-first and skips collapsed ones", () => {
    const listings = new Map(Object.entries(TREE));
    expect(flattenTree(listings, new Set(["a"]), true).map((r) => r.path)).toEqual([
      "a",
      "a/x",
      "a/one.ts",
      "b",
      "node_modules",
      ".env",
      "README.md",
    ]);
  });

  it("hides dotfiles unless asked", () => {
    const listings = new Map(Object.entries(TREE));
    expect(flattenTree(listings, new Set(), false).map((r) => r.name)).not.toContain(".env");
  });

  it("keeps an expanded subtree's state under a collapsed parent", () => {
    const listings = new Map(Object.entries(TREE));
    const rows = flattenTree(listings, new Set(["a/x"]), true).map((r) => r.path);
    expect(rows).not.toContain("a/x/deep.ts");
    const reopened = flattenTree(listings, new Set(["a", "a/x"]), true).map((r) => r.path);
    expect(reopened).toContain("a/x/deep.ts");
  });

  it("reuses row objects across flattens", () => {
    const listings = new Map(Object.entries(TREE));
    const before = flattenTree(listings, new Set(), true);
    const after = flattenTree(listings, new Set(["a"]), true);
    expect(after.find((r) => r.path === "b")).toBe(before.find((r) => r.path === "b"));
  });

  it("derives depth and flags from the entry", () => {
    const listings = new Map(Object.entries(TREE));
    const rows = flattenTree(listings, new Set(["a", "a/x"]), true);
    expect(rows.find((r) => r.path === "a/x/deep.ts")?.depth).toBe(2);
    expect(rows.find((r) => r.path === "node_modules")?.ignored).toBe(true);
  });
});

describe("ProjectTreeModel", () => {
  it("loads the root and lists its rows", async () => {
    const { read } = disk(TREE);
    const m = new ProjectTreeModel("/p", read, { showHidden: true });
    expect(m.getSnapshot().ready).toBe(false);
    await m.load([""]);
    expect(m.getSnapshot().ready).toBe(true);
    expect(paths(m)).toEqual(["a", "b", "node_modules", ".env", "README.md"]);
  });

  it("expands: opens at once, marks loading, then shows children", async () => {
    const { read } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    const done = m.expand("a");
    expect(m.getSnapshot().expanded.has("a")).toBe(true);
    expect(m.getSnapshot().loading.has("a")).toBe(true);
    await done;
    expect(m.getSnapshot().loading.has("a")).toBe(false);
    expect(paths(m)).toEqual(["a", "a/x", "a/one.ts", "b", "node_modules", "README.md"]);
  });

  it("collapses without re-reading, and reopens from the cache", async () => {
    const { read, calls } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("a");
    m.collapse("a");
    expect(paths(m)).not.toContain("a/one.ts");
    const before = calls.length;
    await m.expand("a");
    expect(calls.length).toBe(before);
    expect(paths(m)).toContain("a/one.ts");
  });

  it("does not re-render rows that did not change: the snapshot is cached", async () => {
    const { read } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    expect(m.getSnapshot()).toBe(m.getSnapshot());
    const listener = vi.fn();
    m.subscribe(listener);
    m.collapse("b"); // already collapsed: no change
    expect(listener).not.toHaveBeenCalled();
  });

  it("batches every directory asked for in one tick into one call", async () => {
    const { read, calls } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await Promise.all([m.load([""]), m.expand("a"), m.expand("b")]);
    expect(calls).toEqual([["", "a", "b"]]);
  });

  it("dedupes a directory already in flight", async () => {
    const { read, calls } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    const first = m.load(["a"]);
    await flushed();
    await Promise.all([first, m.load(["a"])]);
    expect(calls).toEqual([["a"]]);
  });

  it("splits a large batch into bounded calls", async () => {
    const many: Record<string, ProjectEntry[]> = { "": [] };
    const dirs = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => `d${i}`);
    for (const d of dirs) many[d] = [];
    const { read, calls } = disk(many);
    const m = new ProjectTreeModel("/p", read);
    await m.load(dirs);
    expect(calls.map((c) => c.length)).toEqual([BATCH_SIZE, 5]);
  });

  it("reveals a deep path with one call for the whole chain", async () => {
    const { read, calls } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    const index = await m.reveal("a/x/deep.ts");
    expect(calls).toEqual([["", "a", "a/x"]]);
    expect(index).toBe(paths(m).indexOf("a/x/deep.ts"));
    expect(index).toBeGreaterThan(0);
  });

  it("reveals -1 for a path that is not there", async () => {
    const { read } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    expect(await m.reveal("a/missing.ts")).toBe(-1);
  });

  it("refreshes only loaded directories and keeps expansion", async () => {
    const { tree, read, calls } = disk(structuredClone(TREE));
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("a");
    tree.a = [...tree.a, file("a/new.ts")];
    calls.length = 0;
    await m.refresh(["a", "b", "elsewhere"]);
    expect(calls).toEqual([["a"]]);
    expect(paths(m)).toContain("a/new.ts");
    expect(m.isExpanded("a")).toBe(true);
  });

  it("forgets the subtree of a folder that disappeared", async () => {
    const { tree, read } = disk(structuredClone(TREE));
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("a");
    await m.expand("a/x");
    tree.a = [file("a/one.ts")];
    delete tree["a/x"];
    await m.refresh();
    expect(m.isLoaded("a/x")).toBe(false);
    expect(m.isExpanded("a/x")).toBe(false);
    expect(paths(m)).not.toContain("a/x/deep.ts");
  });

  it("ignores a stale answer that lands after a fresher one", async () => {
    let release: (() => void) | null = null;
    let call = 0;
    const read: DirectoryReader = async (_root, ps) => {
      call++;
      if (call === 1) {
        await new Promise<void>((r) => (release = r));
        return ps.map((path) => ({ path, entries: [file("old.ts")] }));
      }
      return ps.map((path) => ({ path, entries: [file("new.ts")] }));
    };
    const m = new ProjectTreeModel("/p", read);
    const slow = m.load([""]);
    await flushed();
    await m.load([""], { force: true });
    release!();
    await slow;
    expect(paths(m)).toEqual(["new.ts"]);
  });

  it("records a failed directory and clears it on success", async () => {
    const { tree, read } = disk(structuredClone(TREE));
    // Listed by the root, but its own read fails (permissions, a race).
    tree[""] = [dir("ghost"), ...tree[""]];
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("ghost");
    expect(m.getSnapshot().errors.get("ghost")).toBe("not found");
    tree.ghost = [];
    await m.refresh(["ghost"]);
    expect(m.getSnapshot().errors.has("ghost")).toBe(false);
  });

  it("expand-all walks every folder but ignored ones, level by level", async () => {
    const { read, calls } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.expandAll();
    expect(m.isExpanded("a")).toBe(true);
    expect(m.isExpanded("a/x")).toBe(true);
    expect(m.isExpanded("node_modules")).toBe(false);
    expect(calls).toEqual([[""], ["a", "b"], ["a/x"]]);
  });

  it("collapse-all closes everything in one change", async () => {
    const { read } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.expandAll();
    const listener = vi.fn();
    m.subscribe(listener);
    m.collapseAll();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(paths(m)).toEqual(["a", "b", "node_modules", "README.md"]);
  });

  it("toggling hidden files re-flattens without a read", async () => {
    const { read, calls } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    const before = calls.length;
    m.setShowHidden(true);
    expect(paths(m)).toContain(".env");
    expect(calls.length).toBe(before);
  });

  it("an identical re-listing keeps the same rows array and tells no one", async () => {
    const { read } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("a");
    const before = m.getSnapshot().rows;
    const listener = vi.fn();
    m.subscribe(listener);
    await m.refresh();
    expect(listener).not.toHaveBeenCalled();
    expect(m.getSnapshot().rows).toBe(before);
  });

  it("a full refresh reads only folders on screen; hidden ones re-read on reopen", async () => {
    const { tree, read, calls } = disk(structuredClone(TREE));
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("a");
    await m.expand("a/x");
    await m.expand("b");
    m.collapse("a"); // a and a/x are loaded but off screen
    calls.length = 0;
    await m.refresh();
    expect(calls).toEqual([["", "b"]]);
    tree["a/x"] = [file("a/x/deep.ts"), file("a/x/fresh.ts")];
    calls.length = 0;
    await m.expand("a");
    expect(calls.flat().sort()).toEqual(["a", "a/x"]);
    expect(paths(m)).toContain("a/x/fresh.ts");
  });

  it("a watcher's folder list skips folders that are collapsed until reopened", async () => {
    const { read, calls } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("a");
    m.collapse("a");
    calls.length = 0;
    await m.refresh(["a"]);
    expect(calls).toEqual([]);
    await m.expand("a");
    expect(calls).toEqual([["a"]]);
  });

  it("clears the error of a folder that was deleted and recreated", async () => {
    const { tree, read } = disk(structuredClone(TREE));
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("b");
    // Deleted: its own read fails while the parent still lists it.
    delete tree.b;
    await m.refresh(["b"]);
    expect(m.getSnapshot().errors.has("b")).toBe(true);
    // Recreated: the parent lists it again and the error goes.
    tree.b = [file("b/two.ts")];
    await m.refresh([""]);
    expect(m.getSnapshot().errors.has("b")).toBe(false);
  });

  it("keeps no error for a folder that is gone from its parent", async () => {
    const { tree, read } = disk(structuredClone(TREE));
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("b");
    delete tree.b;
    tree[""] = tree[""].filter((e) => e.path !== "b");
    await m.refresh(["", "b"]);
    expect(m.getSnapshot().errors.size).toBe(0);
    expect(m.isExpanded("b")).toBe(false);
  });

  it("discards an in-flight load for a folder that was dropped", async () => {
    let release: (() => void) | null = null;
    const tree = structuredClone(TREE);
    const read: DirectoryReader = async (_root, ps) => {
      if (ps.includes("a/x")) await new Promise<void>((r) => (release = r));
      return ps.map((path) => ({ path, entries: tree[path] ?? [] }));
    };
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expand("a");
    const slow = m.expand("a/x");
    await flushed();
    tree.a = [file("a/one.ts")]; // a/x deleted
    await m.refresh(["a"]);
    release!();
    await slow;
    expect(m.isLoaded("a/x")).toBe(false);
  });

  it("keeps request bookkeeping only while a request is out", async () => {
    const { read } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    await m.expandAll();
    for (let i = 0; i < 5; i++) await m.refresh();
    // One entry per directory ever read would grow with every folder opened
    // over a long session; answered requests leave nothing behind.
    expect(m["generation"].size).toBe(0);
  });

  it("keeps rows identical when a refresh returns the same listing", async () => {
    const { read } = disk(TREE);
    const m = new ProjectTreeModel("/p", read);
    await m.load([""]);
    const before = m.getSnapshot().rows;
    await m.refresh();
    const after = m.getSnapshot().rows;
    expect(after.every((row, i) => row === before[i])).toBe(true);
  });
});

describe("compacted folder chains", () => {
  const CHAIN: Record<string, ProjectEntry[]> = {
    "": [dir("vendor"), dir("src"), file("README.md")],
    vendor: [dir("vendor/engine")],
    "vendor/engine": [dir("vendor/engine/core")],
    "vendor/engine/core": [file("vendor/engine/core/lib.rs"), file("vendor/engine/core/mod.rs")],
    src: [dir("src/a"), file("src/main.ts")],
    "src/a": [file("src/a/x.ts")],
  };

  it("draws a folder whose only child is a folder as one row, as far as the chain goes", () => {
    const rows = flattenTree(new Map(Object.entries(CHAIN)), new Set(), true);
    expect(rows[0]).toMatchObject({
      path: "vendor/engine/core",
      name: "core",
      depth: 0,
      chain: ["vendor", "vendor/engine", "vendor/engine/core"],
    });
    expect(rows.map((r) => r.path)).toEqual(["vendor/engine/core", "src", "README.md"]);
  });

  it("stops at a folder that is not loaded yet, and never compacts a folder with siblings", () => {
    const partial = new Map(Object.entries(CHAIN));
    partial.delete("vendor/engine");
    const rows = flattenTree(partial, new Set(), true);
    expect(rows[0].chain).toEqual(["vendor", "vendor/engine"]);
    expect(rows.find((r) => r.path === "src")?.chain).toBeUndefined();
  });

  it("opens only when every link is open, and draws the children one level in", () => {
    const listings = new Map(Object.entries(CHAIN));
    const half = flattenTree(listings, new Set(["vendor", "vendor/engine"]), true);
    expect(half.map((r) => r.path)).not.toContain("vendor/engine/core/lib.rs");
    const open = flattenTree(
      listings,
      new Set(["vendor", "vendor/engine", "vendor/engine/core"]),
      true,
    );
    expect(open.find((r) => r.path === "vendor/engine/core/lib.rs")?.depth).toBe(1);
  });

  it("keeps the compacted row's identity across flattens", () => {
    const listings = new Map(Object.entries(CHAIN));
    const a = flattenTree(listings, new Set(), true)[0];
    const b = flattenTree(listings, new Set(["src"]), true)[0];
    expect(b).toBe(a);
  });

  it("does not count a hidden only-child unless hidden files are shown", () => {
    const listings = new Map(
      Object.entries({ "": [dir("pkg")], pkg: [dir("pkg/.cache"), dir("pkg/src")] }),
    );
    expect(flattenTree(listings, new Set(), false)[0].chain).toEqual(["pkg", "pkg/src"]);
    expect(flattenTree(listings, new Set(), true)[0].chain).toBeUndefined();
  });

  it("finds a chain row by any of its links", async () => {
    const rows = flattenTree(new Map(Object.entries(CHAIN)), new Set(), true);
    expect(rowIndexOf(rows, "vendor")).toBe(0);
    expect(rowIndexOf(rows, "vendor/engine")).toBe(0);
    expect(rowIndexOf(rows, "src")).toBe(1);
    expect(rowIndexOf(rows, "nowhere")).toBe(-1);
    // So revealing an outer link highlights the chain row.
    const { read } = disk(CHAIN);
    const m = new ProjectTreeModel("/c", read);
    await m.load([""]);
    await m.reveal("vendor/engine/core/lib.rs");
    expect(m.indexOf("vendor")).toBe(0);
  });

  it("maps a folder that folded into a chain to the row now drawing it", () => {
    // `vendor` was a row of its own (focused, selected) until its listing
    // loaded; then it became the outer link of `vendor / engine / core`.
    const before = flattenTree(new Map([["", CHAIN[""]]]), new Set(), true);
    expect(before[0].path).toBe("vendor");
    const after = flattenTree(new Map(Object.entries(CHAIN)), new Set(), true);
    const owners = chainOwners(after);
    expect(owners.get("vendor")).toBe("vendor/engine/core");
    expect(owners.get("vendor/engine")).toBe("vendor/engine/core");
    // The row's own path and plain rows are not remapped.
    expect(owners.has("vendor/engine/core")).toBe(false);
    expect(owners.has("src")).toBe(false);
  });

  it("opening the head of a chain opens the whole chain as it loads", async () => {
    const { read } = disk(CHAIN);
    const m = new ProjectTreeModel("/c", read);
    await m.load([""]);
    await m.expand("vendor");
    expect(m.isExpanded("vendor/engine")).toBe(true);
    expect(m.isExpanded("vendor/engine/core")).toBe(true);
    expect(paths(m)).toContain("vendor/engine/core/lib.rs");
    // Closing the row closes the chain.
    await m.setRowExpanded(m.getSnapshot().rows[0], false);
    expect(m.isExpanded("vendor")).toBe(false);
    expect(paths(m)).not.toContain("vendor/engine/core/lib.rs");
  });
});
