// @vitest-environment happy-dom
//
// The overlay's two history readers (lineage, pull requests) share one read,
// and a burst of thread-store change events costs one more read, not one per
// event per reader.

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const threadHistory = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Set<() => void>());
const stop = vi.hoisted(() => vi.fn());
vi.mock("@/features/chat/lib/history-api", () => ({
  threadHistory,
  onThreadsChanged: (cb: () => void) => {
    listeners.add(cb);
    return Promise.resolve(() => {
      listeners.delete(cb);
      stop();
    });
  },
}));
vi.mock("@/features/chat/lib/open-thread", () => ({ openThread: vi.fn() }));
vi.mock("@/features/chat/lib/sidebar-agents", () => ({ sidebarAgentOf: vi.fn() }));

import {
  HISTORY_COALESCE_MS,
  resetThreadHistoryForTests,
  useThreadHistory,
} from "./session-lineage";

function Reader({ onRows }: { onRows: (n: number) => void }) {
  const rows = useThreadHistory(true);
  onRows(rows.length);
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  threadHistory.mockReset();
  threadHistory.mockResolvedValue([{ threadId: "t1", sessionId: "s1" }]);
  resetThreadHistoryForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useThreadHistory", () => {
  it("reads once for two readers, and once per burst of change events", async () => {
    const seen: number[] = [];
    await act(async () => {
      render(
        <>
          <Reader onRows={(n) => seen.push(n)} />
          <Reader onRows={(n) => seen.push(n)} />
        </>,
      );
    });
    expect(threadHistory).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    expect(seen[seen.length - 1]).toBe(1);

    await act(async () => {
      for (let i = 0; i < 5; i++) for (const fire of listeners) fire();
      await vi.advanceTimersByTimeAsync(HISTORY_COALESCE_MS + 10);
    });
    expect(threadHistory).toHaveBeenCalledTimes(2);
  });

  it("stops listening when the last reader goes", async () => {
    let view: ReturnType<typeof render> | undefined;
    await act(async () => {
      view = render(<Reader onRows={() => {}} />);
    });
    view!.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(stop).toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("reads nothing while disabled", () => {
    function Off() {
      useThreadHistory(false);
      return null;
    }
    render(<Off />);
    expect(threadHistory).not.toHaveBeenCalled();
  });
});
