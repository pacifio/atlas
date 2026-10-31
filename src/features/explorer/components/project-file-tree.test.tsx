// @vitest-environment happy-dom
/**
 * The tree's search field and the rows it filters: typing never waits on the
 * index, one pause asks once for that project, the search survives the hand
 * off to a file's tab, and focus follows a folder that folds into a chain.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../hooks/use-external-file-drop", () => ({
  useExternalFileDrop: () => ({ externalDropPath: null }),
}));
vi.mock("@/features/git/lib/use-working-tree-changes", () => ({
  useWorkingTreeChanges: () => ({ files: new Map(), dirs: new Map() }),
}));
const openInProject = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../lib/open-in-project", () => ({ openInProject }));

import type { ProjectEntry } from "../lib/fs-api";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { dropProjectTreeModel } from "../lib/project-tree-model";
import { SEARCH_DEBOUNCE_MS } from "../lib/tree-search";
import { ProjectFileTree } from "./project-file-tree";

const dir = (path: string): ProjectEntry => ({ path, kind: "directory" });
const file = (path: string): ProjectEntry => ({ path, kind: "file" });

/** The fake disk. `vendor` holds one folder, so it compacts once loaded. */
let disk: Record<string, ProjectEntry[]>;
let indexHits: string[];

// The virtualizer draws nothing into a zero-sized scroller.
const sized = (key: SizeKey, value: number) =>
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, key) ??
  Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => value });
const SIZES = {
  offsetHeight: 600,
  offsetWidth: 300,
  // The virtualizer reads the scroller's rect from client*, not offset*.
  clientHeight: 600,
  clientWidth: 300,
} as const;
type SizeKey = keyof typeof SIZES;
const KEYS = Object.keys(SIZES) as SizeKey[];
const originals = new Map(
  KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)]),
);
beforeAll(() => {
  for (const key of KEYS) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get: () => SIZES[key],
    });
  }
});
afterAll(() => {
  for (const key of KEYS) {
    const desc = originals.get(key);
    if (desc) Object.defineProperty(HTMLElement.prototype, key, desc);
    else sized(key, 0);
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  disk = {
    "": [dir("src"), dir("vendor"), file("README.md")],
    src: [dir("src/a"), file("src/main.ts")],
    "src/a": [file("src/a/one.ts"), file("src/a/two.ts")],
    vendor: [dir("vendor/engine")],
    "vendor/engine": [file("vendor/engine/lib.rs")],
  };
  indexHits = ["src/main.ts"];
  invoke.mockReset();
  openInProject.mockClear();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "read_directories") {
      return (args.paths as string[]).map((path) =>
        path in disk ? { path, entries: disk[path] } : { path, entries: [], error: "gone" },
      );
    }
    if (cmd === "fileindex_search") return indexHits.map((rel) => ({ path: `/p/${rel}`, rel }));
    if (cmd === "fileindex_open_project") return 1;
    return null;
  });
  useProjectStore.setState({
    projects: [
      { id: "w-1", name: "atlas", path: "/p" },
      { id: "w-2", name: "other", path: "/q" },
    ] as never,
    activeProjectId: "w-2",
  });
});
afterEach(() => {
  cleanup();
  dropProjectTreeModel("/p");
  vi.useRealTimers();
});

const searches = () => invoke.mock.calls.filter(([cmd]) => cmd === "fileindex_search");
const settle = () => act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 4));
const rowPaths = () =>
  screen.queryAllByRole("treeitem").map((el) => (el as HTMLElement).dataset.relPath);
const field = () => screen.getByPlaceholderText<HTMLInputElement>("Search files");
const typeQuery = async (value: string) => {
  fireEvent.change(field(), { target: { value } });
  await settle();
};

describe("tree search", () => {
  it("asks the index once per pause, for the tree's own project", async () => {
    render(<ProjectFileTree root="/p" activeFile={null} />);
    for (const value of ["m", "ma", "mai", "main"]) {
      fireEvent.change(field(), { target: { value } });
      await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS / 2));
    }
    expect(searches()).toHaveLength(0);
    await act(async () => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(searches()).toHaveLength(1);
    // The tree's project, not the active one.
    expect(searches()[0][1]).toMatchObject({ query: "main", workspaceId: "w-1" });
  });

  it("sends the index a query its operators cannot reinterpret", async () => {
    render(<ProjectFileTree root="/p" activeFile={null} />);
    await typeQuery("^main");
    const calls = searches();
    expect(calls[calls.length - 1][1]).toMatchObject({ query: "\\^main" });
  });

  it("clears and gives the tree back on Escape", async () => {
    render(<ProjectFileTree root="/p" activeFile={null} />);
    fireEvent.change(field(), { target: { value: "zzz" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(field().value).toBe("");
    await settle();
    expect(searches()).toHaveLength(0);
  });

  it("filters the tree in place, and a file picked from it keeps the search in the file's tab", async () => {
    const files = render(<ProjectFileTree root="/p" activeFile={null} />);
    await settle();
    await typeQuery("main");
    expect(rowPaths()).toEqual(["src", "src/main.ts"]);
    fireEvent.click(screen.getByText("main.ts"));
    expect(openInProject).toHaveBeenCalledWith("/p/src/main.ts", undefined);
    // The Files surface hands off: it closes, and the file's tab mounts its
    // own tree pointed at the file.
    files.unmount();
    render(<ProjectFileTree root="/p" activeFile="/p/src/main.ts" />);
    await settle();
    expect(field().value).toBe("main");
    expect(rowPaths()).toEqual(["src", "src/main.ts"]);
  });

  it("ends the search when something else points the tree at a file", async () => {
    const first = render(<ProjectFileTree root="/p" activeFile={null} />);
    await settle();
    await typeQuery("main");
    first.unmount();
    // Opened from elsewhere (another tab, ⌘P): not this search's pick.
    render(<ProjectFileTree root="/p" activeFile="/p/README.md" />);
    await settle();
    expect(field().value).toBe("");
  });

  it("drops a deleted file from the results and asks the index again", async () => {
    indexHits = ["src/main.ts", "src/old.ts"];
    disk.src = [...disk.src, file("src/old.ts")];
    render(<ProjectFileTree root="/p" activeFile={null} />);
    await settle();
    await act(async () => fireEvent.click(screen.getByText("src")));
    await settle();
    await typeQuery(".ts");
    expect(rowPaths()).toContain("src/old.ts");
    const asked = searches().length;
    // Deleted on disk; the index has not caught up yet.
    disk.src = disk.src.filter((e) => e.path !== "src/old.ts");
    await act(async () => fireEvent.click(screen.getByLabelText("Refresh")));
    await settle();
    expect(rowPaths()).not.toContain("src/old.ts");
    expect(searches().length).toBeGreaterThan(asked);
  });

  it("keeps folders closed by hand when the same query is asked again", async () => {
    indexHits = ["src/a/one.ts", "src/a/two.ts", "src/main.ts"];
    render(<ProjectFileTree root="/p" activeFile={null} />);
    await settle();
    await typeQuery(".ts");
    expect(rowPaths()).toContain("src/a/one.ts");
    fireEvent.click(screen.getByText("a"));
    expect(rowPaths()).not.toContain("src/a/one.ts");
    await act(async () => fireEvent.click(screen.getByLabelText("Refresh")));
    await settle();
    expect(rowPaths()).toContain("src/a");
    expect(rowPaths()).not.toContain("src/a/one.ts");
  });
});

describe("compacted folders", () => {
  it("moves focus and selection to the chain row a folder folds into", async () => {
    const view = render(<ProjectFileTree root="/p" activeFile={null} />);
    await settle();
    expect(rowPaths()).toEqual(["src", "vendor", "README.md"]);
    // Clicking `vendor` focuses it and opens it; its listing then folds it
    // into `vendor / engine`.
    await act(async () => fireEvent.click(screen.getByText("vendor")));
    await settle();
    expect(rowPaths()).toEqual(["src", "vendor/engine", "vendor/engine/lib.rs", "README.md"]);
    const tree = view.container.querySelector<HTMLElement>("[data-tree-root]")!;
    expect(tree.getAttribute("aria-activedescendant")).toContain("vendor_47engine");
    // ↓ goes to the next row, not to the top.
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.getAttribute("aria-activedescendant")).toContain("lib_46rs");
  });
});

describe("the row menu", () => {
  it("opens a file in the default app through Rust, not the opener plugin's JS", async () => {
    render(<ProjectFileTree root="/p" activeFile={null} />);
    await settle();
    fireEvent.contextMenu(screen.getByText("README.md"));
    await settle();
    await act(async () => fireEvent.click(screen.getByText("Open in Default App")));
    await settle();
    expect(invoke).toHaveBeenCalledWith("external_editor_open", {
      editor: "system",
      path: "/p/README.md",
      line: null,
      column: null,
    });
  });
});
