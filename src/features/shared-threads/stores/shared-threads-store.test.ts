import { beforeEach, describe, expect, it, vi } from "vitest";

// The store talks to Rust only through these; the live-tail logic does not.
vi.mock("../lib/shared-threads-api", () => ({
  listThreads: () => Promise.resolve([]),
  onSharedThreadsChanged: () => Promise.resolve(() => {}),
  onSharedRunFrame: () => Promise.resolve(() => {}),
  onJoinRequested: () => Promise.resolve(() => {}),
}));

const { runKey, runLockFor, useSharedThreadsStore } = await import("./shared-threads-store");

beforeEach(() => useSharedThreadsStore.setState({ live: {} }));

describe("live Run frames (ATL-405)", () => {
  it("keeps the tail of each Run's answer text, per thread and Run", () => {
    const { heard } = useSharedThreadsStore.getState();
    heard({ sharedThreadId: "T", runNo: 1, delta: { kind: "text_chunk", delta: "Looking" } });
    heard({ sharedThreadId: "T", runNo: 1, delta: { kind: "text_chunk", delta: " at it." } });
    heard({ sharedThreadId: "T", runNo: 2, delta: { kind: "text_chunk", delta: "Other run" } });
    const { live } = useSharedThreadsStore.getState();
    expect(live[runKey("T", 1)]).toBe("Looking at it.");
    expect(live[runKey("T", 2)]).toBe("Other run");
  });

  it("ignores deltas that are not answer text, and bounds what it keeps", () => {
    const { heard } = useSharedThreadsStore.getState();
    heard({ sharedThreadId: "T", runNo: 1, delta: { kind: "tool_call_upserted" } });
    expect(useSharedThreadsStore.getState().live).toEqual({});
    heard({
      sharedThreadId: "T",
      runNo: 1,
      delta: { kind: "text_chunk", delta: "x".repeat(1000) },
    });
    expect(useSharedThreadsStore.getState().live[runKey("T", 1)]).toHaveLength(280);
  });
});

describe("the prompt box in a thread's Run worktree (ATL-406)", () => {
  const thread = (role: string, readOnly: string | null) =>
    ({
      sharedThreadId: "T",
      role,
      runWorktree: "/data/shared-threads/T/run",
      status: { readOnly },
    }) as unknown as Parameters<typeof runLockFor>[0][number];

  it("is locked for a viewer, with the reason", () => {
    const why = "You are a viewer in this thread: your edits stay on this machine and are not shared.";
    expect(runLockFor([thread("viewer", why)], "/data/shared-threads/T/run")).toBe(why);
    expect(runLockFor([thread("viewer", null)], "/data/shared-threads/T/run")).toMatch(/viewer/);
  });

  it("is locked on a closed thread, and open for a participant", () => {
    expect(runLockFor([thread("participant", "This thread is closed.")], "/data/shared-threads/T/run")).toBe(
      "This thread is closed.",
    );
    expect(runLockFor([thread("participant", null)], "/data/shared-threads/T/run")).toBeNull();
  });

  it("leaves every other session alone", () => {
    expect(runLockFor([thread("viewer", "x")], "/home/me/project")).toBeNull();
    expect(runLockFor([thread("viewer", "x")], undefined)).toBeNull();
  });
});
