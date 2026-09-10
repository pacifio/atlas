// @vitest-environment happy-dom
//
// The scroll loop must not learn anything from a HIDDEN scroller. A chat tab
// that stays mounted while another tab is showing can be `display:none` (a
// background workspace), and a `display:none` scroller reports 0×0 with
// `scrollTop` 0. Fed to `sample()` that reads as "at the end, and at the very
// top": the at-end flag latched, so a reader who had scrolled up in a
// background streaming tab was snapped to the bottom on return, and the grow
// trigger fired a prepend into a panel nobody was looking at.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTranscriptScroll } from "./use-transcript-scroll";

let resizeCallbacks: ResizeObserverCallback[] = [];
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  resizeCallbacks = [];
  frames = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: ResizeObserverCallback) {
        resizeCallbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // Queued, NOT synchronous: `frame.current = requestAnimationFrame(sample)`
  // would otherwise run `sample` (which nulls the ref) before the assignment
  // lands, latching "a frame is pending" for the rest of the test.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Geometry {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
}

function setGeometry(el: HTMLElement, g: Geometry): void {
  let top = g.scrollTop;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => g.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => g.clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = v;
    },
  });
}

function fireResize(): void {
  for (const cb of resizeCallbacks) cb([], {} as ResizeObserver);
}

function flushFrames(): void {
  const queued = frames.splice(0);
  for (const cb of queued) cb(0);
}

const VISIBLE: Geometry = { scrollHeight: 5000, clientHeight: 600, scrollTop: 3000 };
const HIDDEN: Geometry = { scrollHeight: 0, clientHeight: 0, scrollTop: 0 };

describe("useTranscriptScroll hidden-panel guard", () => {
  it("ignores a 0×0 sample and re-measures once the panel is visible again", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    setGeometry(scroller, VISIBLE);
    const onGrow = vi.fn();

    const { result } = renderHook(() =>
      useTranscriptScroll({
        scrollRef: { current: scroller },
        contentRef: { current: content },
        canGrow: true,
        onGrow,
      }),
    );

    // Visible, scrolled up into history: not at the end, more below.
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(false);
    expect(result.current.more).toBe(true);
    expect(onGrow).not.toHaveBeenCalled();

    // Hidden: the observer fires with everything at zero. Nothing may change.
    setGeometry(scroller, HIDDEN);
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(false);
    expect(result.current.more).toBe(true);
    expect(onGrow).not.toHaveBeenCalled();

    // Shown again with the same geometry: still where the reader left it.
    setGeometry(scroller, VISIBLE);
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(false);
    expect(result.current.more).toBe(true);
    expect(onGrow).not.toHaveBeenCalled();

    // A real scroll to the bottom is still seen — the guard only skips the
    // hidden sample, it does not stick the cached geometry.
    setGeometry(scroller, { ...VISIBLE, scrollTop: 4400 });
    act(() => {
      result.current.onScroll();
      flushFrames();
    });
    expect(result.current.atEndRef.current).toBe(true);
    expect(result.current.more).toBe(false);
  });

  it("does not grow the window from a hidden panel's scrollTop of 0", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    setGeometry(scroller, HIDDEN);
    const onGrow = vi.fn();
    const onBeforeGrow = vi.fn();

    renderHook(() =>
      useTranscriptScroll({
        scrollRef: { current: scroller },
        contentRef: { current: content },
        canGrow: true,
        onGrow,
        onBeforeGrow,
      }),
    );
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(onBeforeGrow).not.toHaveBeenCalled();
    expect(onGrow).not.toHaveBeenCalled();

    // Visible near the top → the normal grow path still works.
    setGeometry(scroller, { scrollHeight: 5000, clientHeight: 600, scrollTop: 100 });
    act(() => {
      fireResize();
      flushFrames();
    });
    expect(onBeforeGrow).toHaveBeenCalledTimes(1);
    expect(onGrow).toHaveBeenCalledTimes(1);
  });
});
