// @vitest-environment happy-dom
/**
 * The frame around a file tab must never remount the file inside it. An
 * editor tab of a background project stays mounted; if the frame changed
 * shape when its file stopped (or started) being "in the project", React
 * would rebuild the editor and drop its unsaved edits and undo history.
 */
import { act, cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useProjectStore } from "@/features/projects/stores/project-store";

import { FileTabFrame } from "./file-tab-frame";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./project-file-tree", () => ({ ProjectFileTree: () => null }));

afterEach(cleanup);

function setProjects(projects: { id: string; path: string }[]) {
  useProjectStore.setState({
    projects: projects.map((p) => ({ ...p, name: p.id })) as never,
  });
}

function Editor({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount]);
  return <div data-testid="editor" />;
}

describe("FileTabFrame", () => {
  it("keeps its child mounted as the file moves in and out of the project", () => {
    setProjects([{ id: "p1", path: "/work/p1" }]);
    const onMount = vi.fn();
    const frame = (projectId: string | null) => (
      <FileTabFrame tabId="t1" projectId={projectId} filePath="/work/p1/src/a.ts">
        <Editor onMount={onMount} />
      </FileTabFrame>
    );
    const { rerender } = render(frame("p1"));
    expect(onMount).toHaveBeenCalledTimes(1);

    // The project's path changes under it (removed, relocated)...
    act(() => setProjects([{ id: "p1", path: "/elsewhere" }]));
    // ...the tab is shown with no project at all...
    rerender(frame(null));
    // ...and back.
    act(() => setProjects([{ id: "p1", path: "/work/p1" }]));
    rerender(frame("p1"));

    expect(onMount).toHaveBeenCalledTimes(1);
  });

  it("reads its root from the tab's own project, not the active one", () => {
    setProjects([
      { id: "p1", path: "/work/p1" },
      { id: "p2", path: "/work/p2" },
    ]);
    useProjectStore.setState({ activeProjectId: "p2" });
    const { container } = render(
      <FileTabFrame tabId="t1" projectId="p1" filePath="/work/p1/src/a.ts">
        <div />
      </FileTabFrame>,
    );
    // Inside its own project, so the header offers the tree toggle, and the
    // body leaves the docked tree its room.
    expect(container.querySelector("[aria-label='Hide file tree']")).not.toBeNull();
    const frame = container.querySelector<HTMLElement>("[data-file-tab-frame]")!;
    expect(frame.style.getPropertyValue("--file-dock-reserve")).not.toBe("0px");
  });
});
