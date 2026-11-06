// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, h: (e: { payload: unknown }) => void) => {
    handlers.set(name, h);
    return () => handlers.delete(name);
  }),
}));

import { healthLine, useMemoryHealth, type HealthStatus } from "./use-memory-health";

const status = (checkedAt: number): HealthStatus => ({
  checkedAt,
  record: { checkedAt, found: [], repaired: [], deferred: [] },
  corpus: { rebuiltVectors: 0, rebuiltFts: false, recreated: false },
  restored: null,
});

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  handlers.clear();
});
afterEach(() => vi.useRealTimers());

describe("useMemoryHealth", () => {
  it("reads on mount and re-reads once after a burst of health events for its project", async () => {
    invoke.mockResolvedValue(status(1));
    const { result } = renderHook(() => useMemoryHealth("/repo"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(result.current?.checkedAt).toBe(1);
    invoke.mockResolvedValue(status(2));
    await act(async () => {
      for (let i = 0; i < 5; i++)
        handlers.get("atlas:memory-health")?.({ payload: { cwd: "/repo" } });
      handlers.get("atlas:memory-health")?.({ payload: { cwd: "/other" } });
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current?.checkedAt).toBe(2);
  });
});

describe("healthLine", () => {
  it("says what the last pass did", () => {
    expect(healthLine(null)).toBeNull();
    expect(healthLine(status(1))).toBe("Memory healthy");
    const repaired = {
      ...status(1),
      record: { ...status(1).record, repaired: [{ kind: "fts_drift" }] },
    };
    expect(healthLine(repaired)).toBe("Memory repaired 1 issue");
    const deferred = {
      ...status(1),
      record: { ...status(1).record, deferred: [{ kind: "vectors_missing" }] },
    };
    expect(healthLine(deferred)).toBe("Memory needs attention: vectors_missing");
    expect(healthLine({ ...status(1), restored: [5, true] })).toBe(
      "Memory was damaged and restored from yesterday's snapshot",
    );
    expect(healthLine({ ...status(1), archived: 3 })).toBe("Memory healthy · archived 3 unused");
  });

  it("names an outside edit of the history", () => {
    const broken = {
      ...status(1),
      record: { ...status(1).record, deferred: [{ kind: "chain_broken", firstBadRev: 4 }] },
    };
    expect(healthLine(broken)).toBe("Memory history was edited outside Atlas");
  });
});
