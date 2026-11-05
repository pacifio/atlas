// @vitest-environment happy-dom
//
// The Session card's body remounts on every expand. The facts it shows must
// come from a cache that is read ONCE, re-read on the events that can change
// them, and ignore the per-turn capture traffic that cannot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const invoke = vi.fn(async (cmd: string): Promise<Record<string, unknown>> =>
  cmd === "capture_binding" ? { mode: "cloud", slug: "atlas", orgId: null } : { root: "/p" },
);
let emit: ((e: { payload: unknown }) => void) | null = null;
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => invoke(cmd) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: unknown }) => void) => {
    emit = cb;
    return () => {};
  }),
}));

const { useProjectFacts, invalidateProjectFacts, resetProjectFactsCache } =
  await import("./project-facts");

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  resetProjectFactsCache();
  invoke.mockClear();
});
afterEach(() => vi.useRealTimers());

const reads = () => invoke.mock.calls.filter(([c]) => c === "capture_binding").length;

describe("useProjectFacts", () => {
  it("reads once, and a remount paints from the cache with no read", async () => {
    const first = renderHook(() => useProjectFacts("/p"));
    await waitFor(() => expect(first.result.current).toBeDefined());
    first.unmount();
    const second = renderHook(() => useProjectFacts("/p"));
    expect(second.result.current?.binding?.slug).toBe("atlas"); // same frame
    expect(reads()).toBe(1);
  });

  it("ignores recording writes and re-reads on a sync-state change", async () => {
    const { result } = renderHook(() => useProjectFacts("/p"));
    await waitFor(() => expect(result.current).toBeDefined());
    act(() => emit?.({ payload: { sessionIds: ["as-1"], all: false } }));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(reads()).toBe(1);
    act(() => emit?.({ payload: null }));
    await act(async () => vi.advanceTimersByTime(1000));
    expect(reads()).toBe(2);
  });

  it("re-reads when the capture setup is changed, and updates only on a difference", async () => {
    const { result } = renderHook(() => useProjectFacts("/p"));
    await waitFor(() => expect(result.current).toBeDefined());
    const before = result.current;
    await act(async () => invalidateProjectFacts("/p"));
    await waitFor(() => expect(reads()).toBe(2));
    expect(result.current).toBe(before); // same answer, same object
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "capture_binding" ? { mode: "local", slug: null, orgId: null } : { root: "/p" },
    );
    await act(async () => invalidateProjectFacts("/p"));
    await waitFor(() => expect(result.current?.binding?.mode).toBe("local"));
  });
});
