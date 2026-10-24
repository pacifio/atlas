// @vitest-environment happy-dom
/**
 * The column's docked file tree, and the tab rules around it.
 *
 * - One tree per column serves the Files tab and every file tab: switching
 *   between them moves that tree, never mounts a second, so its scroll,
 *   search and open folders survive (the tree is virtualized, and rebuilding
 *   it on every tab switch was the cost this replaces).
 * - With Files active it fills the column; with a file active it docks on the
 *   right, under the file's header band, and the file's frame leaves it room.
 * - Files is the one tab another replaces: the first file picked from it takes
 *   its place. Every file after that adds a tab, or focuses the one it has.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

const tree = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
  mounts: 0,
}));
vi.mock("./project-file-tree", async () => {
  const { useEffect } = await import("react");
  return {
    ProjectFileTree: (props: Record<string, unknown>) => {
      tree.props = props;
      useEffect(() => {
        tree.mounts++;
      }, []);
      return null;
    },
  };
});

import { revealFiles, toggleFiles, FILES_TAB } from "@/features/layout/lib/files-surface";
import { useLayoutStore, type Tab } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { openFileAs } from "@/lib/open-file";
import { useFilesRevealStore } from "../stores/files-reveal-store";
import { useFileTabTreeStore } from "../stores/file-tab-tree-store";
import { FILE_DOCK_RESERVE_VAR } from "../lib/file-tabs";
import { FileDockColumn, fileDockMode } from "./file-dock";
import { FileTabFrame } from "./file-tab-frame";

const tab = (id: string, type: Tab["type"], groupId: string, filePath?: string): Tab => ({
  id,
  type,
  title: id,
  closable: true,
  dirty: false,
  data: filePath ? { filePath } : {},
  groupId,
});

const layout = () => useLayoutStore.getState();

beforeEach(() => {
  tree.props = null;
  tree.mounts = 0;
  useFilesRevealStore.setState({ request: null });
  useFileTabTreeStore.setState({ shown: true });
  useProjectStore.setState({
    projects: [{ id: "w-1", name: "atlas", path: "/p" }] as never,
    activeProjectId: "w-1",
  });
  useLayoutStore.setState({
    tabs: [tab("chat-1", "chat", "main"), tab("terminal-1", "terminal", "g2")],
    groupOrder: ["main", "g2"],
    activeByGroup: { main: "chat-1", g2: "terminal-1" },
    focusedGroupId: "main",
    activeTabId: "chat-1",
    destination: null,
    destinationShown: false,
  });
});
afterEach(cleanup);

/** The column the way `TabContentContainer` renders it: the dock around the
 *  active tab's frame. */
function Column({ groupId = "g2" }: { groupId?: string }) {
  const all = useLayoutStore((s) => s.tabs);
  const tabs = all.filter((t) => t.groupId === groupId);
  const activeId = useLayoutStore((s) => s.activeByGroup[groupId]);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  return (
    <div>
      <FileDockColumn projectId="w-1" projectActive tabs={tabs} activeTab={active}>
        {tabs
          .filter((t) => t.data.filePath)
          .map((t) => (
            <FileTabFrame
              key={t.id}
              tabId={t.id}
              projectId="w-1"
              filePath={t.data.filePath as string}
            >
              <div />
            </FileTabFrame>
          ))}
      </FileDockColumn>
    </div>
  );
}

const dock = (root: HTMLElement) => root.querySelector<HTMLElement>("[data-file-dock]");

describe("fileDockMode", () => {
  const file = { type: "editor", data: { filePath: "/p/src/a.ts" } } as const;
  it("fills the column on Files, docks beside a project file, and is off otherwise", () => {
    const root = "/p";
    expect(fileDockMode({ root, activeTab: { type: "files", data: {} }, treeShown: false })).toBe(
      "full",
    );
    expect(fileDockMode({ root, activeTab: file, treeShown: true })).toBe("docked");
    // The toolbar's toggle hid it.
    expect(fileDockMode({ root, activeTab: file, treeShown: false })).toBe("off");
    // Outside the project, or not a file at all.
    expect(
      fileDockMode({
        root,
        activeTab: { type: "editor", data: { filePath: "/elsewhere/a.ts" } },
        treeShown: true,
      }),
    ).toBe("off");
    expect(fileDockMode({ root, activeTab: { type: "terminal", data: {} }, treeShown: true })).toBe(
      "off",
    );
    expect(fileDockMode({ root: null, activeTab: file, treeShown: true })).toBe("off");
  });
});

describe("Files tab and file tabs", () => {
  it("Files opens beside the session, and opening it again focuses the one tab", () => {
    revealFiles();
    revealFiles();
    const files = layout().tabs.filter((t) => t.type === "files");
    expect(files).toHaveLength(1);
    expect(files[0].groupId).not.toBe("main");
    expect(layout().activeByGroup[files[0].groupId!]).toBe(files[0].id);
  });

  it("⌘B toggles: opens Files beside the session, closes it when on screen", () => {
    useFilesRevealStore.getState().actions.reveal("/p/stale.ts");
    toggleFiles();
    expect(layout().tabs.some((t) => t.type === "files")).toBe(true);
    // A toggle follows the reader; it never revives an old reveal.
    expect(useFilesRevealStore.getState().request).toBeNull();
    toggleFiles();
    expect(layout().tabs.some((t) => t.type === "files")).toBe(false);
  });

  it("the first file replaces Files; the next adds a tab; an open file is focused, not doubled", async () => {
    useLayoutStore.setState({
      tabs: [tab("chat-1", "chat", "main"), { ...FILES_TAB, groupId: "g2" }],
      activeByGroup: { main: "chat-1", g2: "files" },
      focusedGroupId: "g2",
    });
    render(<Column />);
    await waitFor(() => expect(tree.props).not.toBeNull());
    const surfaceTabs = () => layout().tabs.filter((t) => t.groupId === "g2");

    // A pick on the Files tab: the file's tab opens, then Files hands off.
    act(() => {
      openFileAs("/p/CLAUDE.md", "text");
      (tree.props!.onFileOpened as () => void)();
    });
    expect(surfaceTabs().map((t) => t.title)).toEqual(["CLAUDE.md"]);

    // Picked from the tree docked beside it: a second tab, focused.
    expect(tree.props!.onFileOpened).toBeUndefined();
    act(() => void openFileAs("/p/clippy.toml", "text"));
    expect(surfaceTabs().map((t) => t.title)).toEqual(["CLAUDE.md", "clippy.toml"]);
    expect(layout().activeByGroup.g2).toBe("editor:/p/clippy.toml");

    // Picking the first again focuses its tab.
    act(() => void openFileAs("/p/CLAUDE.md", "text"));
    expect(surfaceTabs()).toHaveLength(2);
    expect(layout().activeByGroup.g2).toBe("editor:/p/CLAUDE.md");
  });
});

describe("FileDockColumn", () => {
  it("keeps one tree mounted across Files, file tabs and other tabs", async () => {
    useLayoutStore.setState({
      tabs: [
        tab("chat-1", "chat", "main"),
        { ...FILES_TAB, groupId: "g2" },
        tab("editor:/p/a.ts", "editor", "g2", "/p/a.ts"),
        tab("editor:/p/b.ts", "editor", "g2", "/p/b.ts"),
        tab("terminal-1", "terminal", "g2"),
      ],
      activeByGroup: { main: "chat-1", g2: "files" },
    });
    const { container } = render(<Column />);
    await waitFor(() => expect(tree.mounts).toBe(1));
    expect(dock(container)?.dataset.fileDock).toBe("full");

    for (const id of ["editor:/p/a.ts", "editor:/p/b.ts", "terminal-1", "editor:/p/a.ts"]) {
      act(() => layout().actions.setActiveTab(id));
    }
    expect(tree.mounts).toBe(1);
    expect(tree.props!.activeFile).toBe("/p/a.ts");

    // Hidden behind the terminal, it stays mounted and keeps its target.
    act(() => layout().actions.setActiveTab("terminal-1"));
    expect(dock(container)?.dataset.fileDock).toBe("off");
    expect(dock(container)?.hasAttribute("inert")).toBe(true);
    expect(tree.props!.activeFile).toBe("/p/a.ts");
    expect(tree.mounts).toBe(1);
  });

  it("docks on the right of a file, under its header, and the file leaves it room", async () => {
    useLayoutStore.setState({
      tabs: [tab("chat-1", "chat", "main"), tab("editor:/p/a.ts", "editor", "g2", "/p/a.ts")],
      activeByGroup: { main: "chat-1", g2: "editor:/p/a.ts" },
    });
    const { container } = render(<Column />);
    await waitFor(() => expect(dock(container)).not.toBeNull());
    const aside = dock(container)!;
    expect(aside.dataset.fileDock).toBe("docked");
    expect(aside.className).toContain("right-0");
    expect(aside.className).toContain("top-(--control-lg)");
    expect(aside.className).toContain("border-l");
    // Its width is `FILE_DOCK_WIDTH`. happy-dom drops `clamp()` from an inline
    // width, so the frame's variable (the same length) stands in for it.
    const frame = container.querySelector<HTMLElement>("[data-file-tab-frame]")!;
    expect(frame.style.getPropertyValue(FILE_DOCK_RESERVE_VAR)).toContain("clamp(");

    // The toolbar's toggle hides it, and the file takes the width back.
    act(() => useFileTabTreeStore.getState().actions.setShown(false));
    expect(aside.dataset.fileDock).toBe("off");
    expect(frame.style.getPropertyValue(FILE_DOCK_RESERVE_VAR)).toBe("0px");
  });

  it("mounts no tree for a background project", () => {
    useLayoutStore.setState({
      tabs: [tab("chat-1", "chat", "main"), { ...FILES_TAB, groupId: "g2" }],
      activeByGroup: { main: "chat-1", g2: "files" },
    });
    const tabs = layout().tabs.filter((t) => t.groupId === "g2");
    const { container } = render(
      <FileDockColumn projectId="w-1" projectActive={false} tabs={tabs} activeTab={tabs[0]}>
        <div />
      </FileDockColumn>,
    );
    expect(dock(container)).toBeNull();
  });

  it("reveals a path asked for on the Files tab, once, and follows the reader without one", async () => {
    revealFiles("/p/src/deep/a.ts");
    const view = render(<Column />);
    await waitFor(() => expect(tree.props?.activeFile).toBe("/p/src/deep/a.ts"));
    const first = tree.props!.revealNonce;
    // Read and cleared: nothing is left for the next Files tab.
    expect(useFilesRevealStore.getState().request).toBeNull();

    act(() => revealFiles("/p/src/deep/a.ts"));
    expect(tree.props!.revealNonce).not.toBe(first);

    // Another project's path is not this tree's to show.
    act(() => revealFiles("/elsewhere/b.ts"));
    expect(tree.props!.activeFile).toBeUndefined();
    view.unmount();
  });
});
