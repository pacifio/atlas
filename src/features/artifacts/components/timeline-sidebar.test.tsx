// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoardSession } from "../types";
import { boardKey } from "../lib/board-key";
import { TimelineSidebar } from "./timeline-sidebar";

// The sidebar's import graph reaches `settings-store`, which subscribes to
// Tauri config events at module load. There is no Tauri bridge under happy-dom,
// so without this the real `listen` rejects and vitest fails the run on an
// unhandled rejection.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

// vitest runs with `globals: false`, so RTL's auto-cleanup is not registered.
beforeEach(cleanup);

// The nav is virtualized, and a virtualizer asks the DOM how tall its scroller
// is. happy-dom lays nothing out, so every box is 0×0 and the window would be
// empty — give it a viewport and a ResizeObserver to hear about it, otherwise
// these tests assert against an empty list and pass for the wrong reason.
const VIEWPORT = { width: 320, height: 900 };
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: VIEWPORT.width,
        bottom: VIEWPORT.height,
        ...VIEWPORT,
        toJSON: () => ({}),
      };
    },
  });
  for (const prop of ["clientHeight", "offsetHeight"] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      value: VIEWPORT.height,
    });
  }
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.scrollTo ??= () => {};
});

function session(over: Partial<BoardSession> & { id: string }): BoardSession {
  // Keep the fixture in today's local calendar bucket. An "hour ago" crosses
  // midnight for the first hour of the day and made this test date-dependent.
  const todayAtNoon = new Date();
  todayAtNoon.setHours(12, 0, 0, 0);
  const hourAgo = todayAtNoon.toISOString();
  return {
    title: `Session ${over.id}`,
    agent: "claude",
    model: "claude-opus-5",
    source: "acp",
    startedAt: hourAgo,
    updatedAt: hourAgo,
    lastActivityAt: hourAgo,
    activeSeconds: 120,
    wallSeconds: 300,
    messageCount: 2,
    toolCallCount: 0,
    checkpointCount: 0,
    branches: [],
    insertions: 0,
    deletions: 0,
    filesTouched: 0,
    totalTokens: 1_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: 0,
    contextSize: 0,
    needsAttention: false,
    attentionReason: null,
    projectPath: "/tmp/atlas",
    projectName: "atlas",
    synced: false,
    origin: "local",
    remoteProjectId: null,
    authorId: null,
    ...over,
  } as BoardSession;
}

describe("TimelineSidebar", () => {
  it("draws one day row per bucket and a title-only row per session", () => {
    const yesterdayDate = new Date();
    yesterdayDate.setHours(12, 0, 0, 0);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = yesterdayDate.toISOString();
    render(
      <TimelineSidebar
        sessions={[
          session({ id: "a", title: "First today" }),
          session({ id: "b", title: "Second today" }),
          session({ id: "c", title: "Old", lastActivityAt: yesterday, updatedAt: yesterday }),
        ]}
        loading={false}
        filtered={false}
        openKey={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Yesterday")).toBeTruthy();
    expect(screen.getByText("First today")).toBeTruthy();
    expect(screen.getByText("Old")).toBeTruthy();
    // Title and Project only. The row's old grid — token counts, model, the
    // Checkpoint tally — stays out; that is what the results table is for.
    expect(screen.queryByText(/tok/)).toBeNull();
    expect(screen.queryByText("claude-opus-5")).toBeNull();
  });

  it("says which Project a row came from, and whether it is shared", () => {
    render(
      <TimelineSidebar
        sessions={[
          session({ id: "a", title: "Local work", projectName: "scratch" }),
          session({
            id: "b",
            title: "Shared work",
            projectName: "atlas",
            synced: true,
            origin: "both",
            remoteProjectId: "rw_1",
          }),
        ]}
        loading={false}
        filtered={false}
        openKey={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("scratch")).toBeTruthy();
    expect(screen.getByText("atlas")).toBeTruthy();
    // The icon carries the state, so it is what the assertion reads — a
    // synced row must be distinguishable without opening it.
    expect(screen.getByLabelText("This machine only")).toBeTruthy();
    expect(screen.getByLabelText("Shared with your Organization")).toBeTruthy();
  });

  it("says whose work each row is, and never prints a raw id", () => {
    // An opaque author key in the byline is noise — it is what the row used to
    // show. With no directory loaded a colleague is still *named*, just not by
    // name; your own work says "You" whether or not it has been pushed.
    render(
      <TimelineSidebar
        sessions={[
          session({ id: "a", title: "Mine", synced: true, origin: "both" }),
          session({
            id: "b",
            title: "Theirs",
            projectPath: "",
            projectName: "acme-infra",
            synced: true,
            origin: "remote",
            authorId: "user_grace",
          }),
        ]}
        loading={false}
        filtered={false}
        openKey={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("A member")).toBeTruthy();
    expect(screen.queryByText("user_grace")).toBeNull();
  });

  it("highlights the open session and opens on click", () => {
    const onOpen = vi.fn();
    render(
      <TimelineSidebar
        sessions={[session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })]}
        loading={false}
        filtered={false}
        openKey={boardKey({ id: "b", projectPath: "/tmp/atlas", remoteProjectId: null })}
        period="day"
        onOpen={onOpen}
      />,
    );
    const beta = screen.getByText("Beta").closest("button")!;
    expect(beta.getAttribute("data-selected")).toBe("true");
    expect(screen.getByText("Alpha").closest("button")!.getAttribute("data-selected")).toBeNull();
    fireEvent.click(screen.getByText("Alpha"));
    // The server Project id rides along: it is what the detail pane needs to
    // load comments and subscribe, and a remote-only row has no path to use.
    expect(onOpen).toHaveBeenCalledWith("a", "/tmp/atlas", null);
  });

  it("shows one Session held by two Projects as two rows and selects only the open one", () => {
    // A Project whose sync moved leaves its copy in the old Project; the same
    // Session id is then on the board once per Project.
    const onOpen = vi.fn();
    const inA = session({ id: "s", title: "In A", projectPath: "", remoteProjectId: "ws_a" });
    const inB = session({
      id: "s",
      title: "In B",
      projectPath: "/tmp/atlas",
      remoteProjectId: "ws_b",
    });
    render(
      <TimelineSidebar
        sessions={[inB, inA]}
        loading={false}
        filtered={false}
        openKey={boardKey(inA)}
        period="day"
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText("In A").closest("button")!.getAttribute("data-selected")).toBe("true");
    expect(screen.getByText("In B").closest("button")!.getAttribute("data-selected")).toBeNull();
    fireEvent.click(screen.getByText("In B"));
    expect(onOpen).toHaveBeenCalledWith("s", "/tmp/atlas", "ws_b");
  });

  it("folds three identical imported titles into one row that expands", () => {
    render(
      <TimelineSidebar
        sessions={["x", "y", "z"].map((id) =>
          session({ id, title: "SHARED MEMORY ---", source: "external_jsonl" }),
        )}
        loading={false}
        filtered={false}
        openKey={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    const fold = screen.getByText("SHARED MEMORY ---").closest("button")!;
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("×3")).toBeTruthy();
    fireEvent.click(fold);
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("SHARED MEMORY ---")).toHaveLength(4);
  });

  it("puts an expanded cluster's children on their own lane", () => {
    render(
      <TimelineSidebar
        sessions={["x", "y", "z"].map((id) =>
          session({ id, title: "SHARED MEMORY ---", source: "external_jsonl" }),
        )}
        loading={false}
        filtered={false}
        openKey={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("SHARED MEMORY ---").closest("button")!);
    // Lane 2 sits one lane right of the folded row on lane 1.
    const [fold, firstChild] = screen.getAllByText("SHARED MEMORY ---").map((el) => {
      const button = el.closest("button")!;
      return Number.parseFloat(button.style.paddingLeft);
    });
    expect(firstChild).toBeGreaterThan(fold);
  });

  it("says why the list is empty", () => {
    render(
      <TimelineSidebar
        sessions={[]}
        loading={false}
        filtered
        openKey={null}
        period="day"
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText("No sessions match this filter.")).toBeTruthy();
  });
});
