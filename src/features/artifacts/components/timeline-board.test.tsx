// @vitest-environment happy-dom
//
// The board's own contract: it groups by the day a Session was last active,
// and it hands a row back whole when you open it.
//
// That last one is a regression guard. `onOpen` used to be called with three
// positional strings — `(sessionId, projectPath, remoteProjectId)` — and the
// first two are both strings, both plausible either way round. Swapped, the
// panel opened a Session id that named a folder, and the detail pane said
// "Session not found". Passing the row itself is what makes that unspellable.

import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { BoardSession } from "../types";
import { EMPTY_DIRECTORY } from "../lib/author-directory";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => p,
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("thinking-orbs", () => ({ ThinkingOrb: () => <span /> }));
// The sticky date animates with `motion`. happy-dom has no real WAAPI, so
// cancelling the animation on unmount rejects — after the test has passed.
// None of these cases are about the animation.
vi.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get:
        (_t, tag: string) =>
        ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => {
          const { initial, animate, exit, transition, ...rest } = props;
          void initial;
          void animate;
          void exit;
          void transition;
          return createElement(tag, rest, children);
        },
    },
  ),
}));

// The list is virtualized. A virtualizer renders nothing when its scroll
// element measures zero, which is every element in happy-dom — so these cases
// would assert against an empty board. Windowing is not what they are about:
// they test the grouping and the open contract, so the window is made total.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    getItemKey,
  }: {
    count: number;
    getItemKey: (i: number) => string;
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 80,
        size: 80,
        end: index * 80 + 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    // The package calendar indexes this for its end space even with
    // `endSpace` off; a missing array would throw.
    measurementsCache: [],
  }),
}));

const { TimelineBoard } = await import("./timeline-board");

const DAY_MS = 86_400_000;

function session(over: Partial<BoardSession> = {}): BoardSession {
  return {
    id: "s1",
    title: "a session",
    agent: "claude-code",
    model: "claude-opus-5-5",
    source: "acp",
    startedAt: "",
    updatedAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    lastActivityAt: new Date(Date.now() - 3 * DAY_MS).toISOString(),
    activeSeconds: 60,
    wallSeconds: 60,
    messageCount: 1,
    toolCallCount: 0,
    checkpointCount: 0,
    branches: [],
    insertions: 0,
    deletions: 0,
    filesTouched: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: null,
    contextSize: null,
    needsAttention: false,
    attentionReason: null,
    projectPath: "/repo",
    projectName: "atlas",
    synced: false,
    origin: "local",
    remoteProjectId: null,
    authorId: null,
    ...over,
  };
}

function board(sessions: BoardSession[], onOpen = vi.fn()) {
  render(
    <TimelineBoard
      sessions={sessions}
      directory={EMPTY_DIRECTORY}
      openKey={null}
      loading={false}
      narrowed={false}
      query=""
      onQuery={vi.fn()}
      onOpen={onOpen}
    />,
  );
  return onOpen;
}

afterEach(cleanup);

describe("TimelineBoard", () => {
  it("hands back the row itself, so its id and its path cannot be swapped", () => {
    const onOpen = board([session({ id: "ses-981", projectPath: "/repo", remoteProjectId: "p1" })]);
    fireEvent.click(screen.getByRole("button", { name: /a session/ }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const row = onOpen.mock.calls[0]![0] as BoardSession;
    expect(row.id).toBe("ses-981");
    expect(row.projectPath).toBe("/repo");
    expect(row.remoteProjectId).toBe("p1");
  });

  it("groups by the day a session was last active, newest first", () => {
    const today = new Date().toISOString();
    const onOpen = vi.fn();
    board(
      [
        session({ id: "a", title: "today one", lastActivityAt: today, updatedAt: today }),
        session({ id: "b", title: "older one" }),
      ],
      onOpen,
    );
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings).toHaveLength(2);
    expect(headings[0]).toContain("Today");
    expect(headings[1]).not.toContain("Today");
  });

  it("says why the list is empty, and tells the two reasons apart", () => {
    render(
      <TimelineBoard
        sessions={[]}
        directory={EMPTY_DIRECTORY}
        openKey={null}
        loading={false}
        narrowed
        query="zzz"
        onQuery={vi.fn()}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText("No sessions match.")).toBeTruthy();
    cleanup();
    board([]);
    expect(screen.getByText("No sessions captured yet.")).toBeTruthy();
  });
});
