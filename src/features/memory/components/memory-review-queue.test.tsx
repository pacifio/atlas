// @vitest-environment happy-dom
// The Review tab: one decision at a time, each sent to the backend, the
// queue re-read after; "Later" puts an item at the back.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }));

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { MemoryReviewQueue } from "./memory-review-queue";
import { EMPTY_REVIEW, useSharedMemoryStore } from "../stores/shared-memory-store";
import type { ReviewQueue } from "../lib/shared-memory-api";

function entry(id: number, content: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "fact",
    key: "",
    content,
    status: "",
    source: "capture",
    agent: "claude-code",
    sessionId: "s1",
    confidence: 0.3,
    createdAt: 1,
    updatedAt: 2,
    lastUsedAt: null,
    uses: 0,
    revision: 1,
    state: "candidate",
    ...over,
  };
}

let queue: ReviewQueue;

function fullQueue(): ReviewQueue {
  return {
    candidates: [entry(1, "Prefers small PRs")],
    merges: [
      {
        keep: entry(5, "Keep PRs small", { state: "active" }),
        drop: [entry(6, "Prefer small PRs", { state: "active" })],
      },
    ],
    conflicts: [
      {
        a: entry(8, "main needs Java 21", { state: "active" }),
        b: entry(9, "main needs Java 17", { state: "active" }),
      },
    ],
    dreams: [
      {
        id: 41,
        op: { op: "archive", id: 10, reason: "transient" },
        why: "task state",
        entries: [entry(10, "PR 412 is in review", { state: "active" })],
      },
    ],
  } as unknown as ReviewQueue;
}

/** Drop whatever an item's decision settled, as the backend would. */
function settle(cmd: string, args: Record<string, unknown>) {
  if (cmd === "memory_resolve_conflict")
    queue = {
      ...queue,
      conflicts: [],
      merges: queue.merges.filter((m) => m.keep.id !== args.a),
    };
  if (cmd === "memory_dream_accept" || cmd === "memory_dream_dismiss")
    queue = { ...queue, dreams: [] };
  if (cmd === "memory_merge") queue = { ...queue, merges: [] };
  if (cmd === "memory_promote" || cmd === "memory_archive") queue = { ...queue, candidates: [] };
}

beforeEach(() => {
  queue = fullQueue();
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "memory_review") return queue;
    if (cmd === "memory_get_state") return null;
    if (cmd === "memory_list_events" || cmd === "memory_list_entries") return [];
    settle(cmd, args);
    return cmd === "memory_dream_accept" ? "accepted" : true;
  });
  vi.mocked(toast).mockClear();
  vi.mocked(toast.error).mockClear();
  useSharedMemoryStore.setState({
    projectPath: "/repo",
    loaded: true,
    error: null,
    review: queue,
    reviewError: null,
  });
});
afterEach(cleanup);

function front() {
  return screen.getAllByRole("article")[0];
}

describe("the review queue", () => {
  it("leads with the contradiction and keeps both when told they both hold", async () => {
    const user = userEvent.setup();
    render(<MemoryReviewQueue />);
    expect(within(front()).getByText("main needs Java 21")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Both hold" }));
    expect(invoke).toHaveBeenCalledWith("memory_resolve_conflict", {
      projectPath: "/repo",
      a: 8,
      b: 9,
      keep: "both",
    });
    // The queue is re-read and the next decision comes forward.
    await waitFor(() => expect(within(front()).getByText("PR 412 is in review")).toBeTruthy());
  });

  it("works through a proposal, a duplicate and a candidate", async () => {
    const user = userEvent.setup();
    queue = { ...queue, conflicts: [] };
    useSharedMemoryStore.setState({ review: queue });
    render(<MemoryReviewQueue />);

    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(invoke).toHaveBeenCalledWith("memory_dream_accept", { projectPath: "/repo", id: 41 });

    await user.click(await screen.findByRole("button", { name: "Merge" }));
    expect(invoke).toHaveBeenCalledWith("memory_merge", {
      projectPath: "/repo",
      keep: 5,
      drop: [6],
    });

    await user.click(await screen.findByRole("button", { name: "Approve" }));
    expect(invoke).toHaveBeenCalledWith("memory_promote", { projectPath: "/repo", id: 1 });
    expect(await screen.findByText("Nothing to review")).toBeTruthy();
  });

  it("settles a false duplicate as two memories", async () => {
    const user = userEvent.setup();
    queue = { ...queue, conflicts: [], dreams: [] };
    useSharedMemoryStore.setState({ review: queue });
    render(<MemoryReviewQueue />);
    await user.click(screen.getByRole("button", { name: "Not the same" }));
    expect(invoke).toHaveBeenCalledWith("memory_resolve_conflict", {
      projectPath: "/repo",
      a: 5,
      b: 6,
      keep: "both",
    });
  });

  it("puts an item off with Later", async () => {
    const user = userEvent.setup();
    render(<MemoryReviewQueue />);
    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(within(front()).getByText("PR 412 is in review")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("memory_resolve_conflict", expect.anything());
  });

  it("says when a proposal went stale", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) =>
      cmd === "memory_dream_accept" ? "obsolete" : base(cmd, args),
    );
    queue = { ...queue, conflicts: [] };
    useSharedMemoryStore.setState({ review: queue });
    const user = userEvent.setup();
    render(<MemoryReviewQueue />);
    await user.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Memory moved on; nothing was changed"));
  });

  it("says when a decision fails", async () => {
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "memory_resolve_conflict") throw new Error("database is locked");
      return base(cmd, args);
    });
    const user = userEvent.setup();
    render(<MemoryReviewQueue />);
    await user.click(screen.getByRole("button", { name: "Keep A" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't update memory: database is locked"),
    );
  });

  it("says when there is nothing to review", () => {
    useSharedMemoryStore.setState({ review: EMPTY_REVIEW });
    render(<MemoryReviewQueue />);
    expect(screen.getByText("Nothing to review")).toBeTruthy();
  });

  it("says the queue could not be read rather than that it is empty", () => {
    useSharedMemoryStore.setState({ review: EMPTY_REVIEW, reviewError: "database is locked" });
    render(<MemoryReviewQueue />);
    expect(screen.getByText("Couldn't read the review queue")).toBeTruthy();
    expect(screen.queryByText("Nothing to review")).toBeNull();
  });
});
