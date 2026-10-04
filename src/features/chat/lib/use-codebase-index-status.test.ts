// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { payload: unknown }) => void;
const handlers = vi.hoisted(() => new Map<string, Handler>());
const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, h: Handler) => {
    handlers.set(name, h);
    return () => handlers.delete(name);
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const { useCodebaseIndexStatus } = await import("./use-codebase-index-status");

const status = (fileCount: number) => ({ indexed: true, fileCount, summaryCount: 0, builtAtMs: 1 });

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  invokeMock.mockReset();
});

// Each test's hook must stop listening before the next one starts, or a
// focus event reaches every hook still mounted.
afterEach(() => {
  cleanup();
});

describe("useCodebaseIndexStatus", () => {
  it("fetches on mount", async () => {
    invokeMock.mockResolvedValue(status(10));
    const { result } = renderHook(() => useCodebaseIndexStatus("/p"));
    await act(async () => {});
    expect(invokeMock).toHaveBeenCalledWith("codebase_index_status", { projectPath: "/p" });
    expect(result.current.status?.fileCount).toBe(10);
  });

  it("refetches once after a burst of progress events", async () => {
    invokeMock.mockResolvedValue(status(10));
    const { result } = renderHook(() => useCodebaseIndexStatus("/p"));
    await act(async () => {});
    invokeMock.mockResolvedValue(status(42));
    await act(async () => {
      for (let i = 0; i < 5; i++)
        handlers.get("atlas:codebase-index:progress")?.({ payload: { phase: "done" } });
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(result.current.status?.fileCount).toBe(42);
  });

  it("refetches when the window regains focus", async () => {
    invokeMock.mockResolvedValue(status(10));
    renderHook(() => useCodebaseIndexStatus("/p"));
    await act(async () => {});
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("drops a stale answer after the project changes", async () => {
    let resolveOld!: (v: unknown) => void;
    invokeMock.mockImplementationOnce(() => new Promise((r) => (resolveOld = r)));
    invokeMock.mockResolvedValueOnce(status(7));
    const { result, rerender } = renderHook(({ p }) => useCodebaseIndexStatus(p), {
      initialProps: { p: "/old" },
    });
    rerender({ p: "/new" });
    await act(async () => {});
    await act(async () => resolveOld(status(999)));
    expect(result.current.status?.fileCount).toBe(7);
  });

  it("does nothing without a project", async () => {
    renderHook(() => useCodebaseIndexStatus(null));
    await act(async () => {});
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
