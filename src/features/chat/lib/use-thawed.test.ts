// @vitest-environment happy-dom
//
// The freeze/thaw clock behind the hidden-transcript freeze. Two things have
// to hold at once: the catch-up must never land on the frame that unhides the
// tab (that frame is the tab switch), and it must land even when WebKit has
// animation frames paused because the window is not frontmost.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THAW_BACKSTOP_MS, useThawed } from "./use-thawed";

/** Sparse by id, so `cancelAnimationFrame` really cancels — the point of the
 *  last test is that the cleanup drops the callback, and a no-op cancel would
 *  let the `visible &&` guard pass the test for the wrong reason. */
let frames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

beforeEach(() => {
  frames = new Map();
  nextFrameId = 0;
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function flushFrames(): void {
  const queued = [...frames.values()];
  frames.clear();
  for (const cb of queued) cb(0);
}

describe("useThawed", () => {
  it("is live from the start when it mounts visible", () => {
    // A tab opened directly, or the chat that is showing when the app boots.
    // Deferring here would put a frozen frame in front of a first paint that
    // has nothing to catch up on.
    const { result } = renderHook(() => useThawed(true));
    expect(result.current).toBe(true);
  });

  it("mounts frozen when hidden and stays frozen", () => {
    const { result } = renderHook(() => useThawed(false));
    expect(result.current).toBe(false);
    act(() => {
      flushFrames();
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(false);
  });

  it("thaws one frame after becoming visible, not on the visible render", () => {
    const { result, rerender } = renderHook(({ v }: { v: boolean }) => useThawed(v), {
      initialProps: { v: true },
    });

    rerender({ v: false });
    expect(result.current).toBe(false);

    // The render that unhides the tab. Still frozen: this is the switch frame.
    rerender({ v: true });
    expect(result.current).toBe(false);

    act(() => {
      flushFrames();
    });
    expect(result.current).toBe(true);
  });

  it("thaws on the timer when animation frames are paused", () => {
    // WebKit stops rAF whenever the webview is not frontmost. Without the
    // backstop the transcript would sit on stale rows for as long as that
    // lasts, which is worse than the stall the deferral avoids.
    const { result, rerender } = renderHook(({ v }: { v: boolean }) => useThawed(v), {
      initialProps: { v: false },
    });

    rerender({ v: true });
    expect(result.current).toBe(false);

    act(() => {
      // No frames delivered, only time passing.
      vi.advanceTimersByTime(THAW_BACKSTOP_MS);
    });
    expect(result.current).toBe(true);
  });

  it("freezes immediately on hide, with no frame to wait for", () => {
    const { result, rerender } = renderHook(({ v }: { v: boolean }) => useThawed(v), {
      initialProps: { v: true },
    });
    expect(result.current).toBe(true);

    rerender({ v: false });
    expect(result.current).toBe(false);
  });

  it("does not thaw from a frame queued by a visibility that was undone", () => {
    // Shown and hidden again inside one frame (a fast ⌥-tab cycle through a
    // column). The queued callback must have been cancelled with the effect,
    // or it would unfreeze a tab that is hidden again.
    const { result, rerender } = renderHook(({ v }: { v: boolean }) => useThawed(v), {
      initialProps: { v: false },
    });

    rerender({ v: true });
    rerender({ v: false });
    act(() => {
      flushFrames();
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(false);
  });
});
