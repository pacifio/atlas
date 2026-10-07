// @vitest-environment happy-dom
//
// The sidebar sorts by recency, and a session another process keeps writing
// moves to the top on every write. While the pointer is over the list (or
// focus is in it) the order must hold, or a row jumps under the pointer between
// aim and click and the click opens the wrong session. Content still updates;
// new rows still appear; leaving applies the real order.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
  changed: new Set<() => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    if (cmd === "threads_projects") {
      return [{ name: "atlas", paths: ["/p/atlas"], isCurrent: true, threads: backend.threads }];
    }
    if (cmd === "threads_sync_project") return 0;
    return undefined;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => {
    if (event !== "atlas:threads-changed") return () => {};
    backend.changed.add(handler);
    return () => backend.changed.delete(handler);
  }),
  emit: vi.fn(async () => {}),
}));

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionSidebar } from "./session-sidebar";

function thread(id: string, updatedAt: string, title = `chat ${id}`, liveElsewhere = false) {
  return {
    threadId: `th-${id}`,
    sessionId: `s-${id}`,
    agentId: "claude-code",
    title,
    updatedAt,
    createdAt: null,
    archived: false,
    projectName: "atlas",
    folderPaths: ["/p/atlas"],
    liveElsewhere,
  };
}

/** Rust answers newest first; the store says it changed. */
function backendNow(threads: Array<Record<string, unknown>>) {
  backend.threads = threads;
  act(() => {
    for (const handler of backend.changed) handler();
  });
}

const titles = () =>
  Array.from(
    screen.getByTestId("session-list").querySelectorAll("span.line-clamp-2"),
    (el) => el.textContent,
  );

beforeEach(() => {
  backend.threads = [
    thread("a", "2026-10-06T10:03:00Z"),
    thread("b", "2026-10-06T10:02:00Z"),
    thread("c", "2026-10-06T10:01:00Z"),
  ];
  backend.changed.clear();
});
afterEach(cleanup);

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionSidebar tabId="tab-1" />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(titles()).toEqual(["chat a", "chat b", "chat c"]));
}

describe("session sidebar order while the pointer is over it", () => {
  it("holds the order while hovered, updates content and adds new rows, and reorders on leave", async () => {
    await mount();
    const list = screen.getByTestId("session-list");
    fireEvent.mouseEnter(list);

    // `c` is written by a terminal: newest now, retitled, live.
    backendNow([
      thread("c", "2026-10-06T10:05:00Z", "chat c (busy)", true),
      thread("a", "2026-10-06T10:03:00Z"),
      thread("b", "2026-10-06T10:02:00Z"),
    ]);
    await waitFor(() => expect(titles()).toContain("chat c (busy)"));
    expect(titles()).toEqual(["chat a", "chat b", "chat c (busy)"]);

    // A brand-new session still shows up, on top; a deleted one goes.
    backendNow([
      thread("d", "2026-10-06T10:06:00Z"),
      thread("c", "2026-10-06T10:05:00Z", "chat c (busy)", true),
      thread("a", "2026-10-06T10:03:00Z"),
    ]);
    await waitFor(() => expect(titles()).toEqual(["chat d", "chat a", "chat c (busy)"]));

    fireEvent.mouseLeave(list);
    await waitFor(() => expect(titles()).toEqual(["chat d", "chat c (busy)", "chat a"]));
  });

  it("treats keyboard focus inside the list like hovering", async () => {
    await mount();
    const list = screen.getByTestId("session-list");
    fireEvent.focus(list.querySelector("button") ?? list);

    backendNow([
      thread("c", "2026-10-06T10:05:00Z"),
      thread("a", "2026-10-06T10:03:00Z"),
      thread("b", "2026-10-06T10:02:00Z"),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(titles()).toEqual(["chat a", "chat b", "chat c"]);

    fireEvent.blur(list.querySelector("button") ?? list, { relatedTarget: document.body });
    await waitFor(() => expect(titles()).toEqual(["chat c", "chat a", "chat b"]));
  });
});
