// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isScrollHot } from "@/lib/scroll-hot";
import { bindUserScrollGestures } from "./use-transcript-scroll";

// The transcript scrolls ITSELF to the live edge on every streaming chunk. When
// the hot mark came from the `scroll` event, that self-scroll marked the reader
// as mid-gesture and the agent-delta flush held the batch — so the stream
// throttled itself with nobody touching the trackpad, and text landed in lumps
// a few times a second instead of every frame.

describe("scroll-hot is a gesture, not a scroll", () => {
  let el: HTMLElement;
  let cleanup: () => void;
  // `scroll-hot` is a monotonic-clock module with no reset, so the clock is the
  // only way to make these deterministic and independent of each other.
  let now = 0;
  const advance = (ms: number) => {
    now += ms;
  };

  beforeEach(() => {
    now += 100_000; // Past any window a previous test left open.
    vi.spyOn(performance, "now").mockImplementation(() => now);
    el = document.createElement("div");
    document.body.appendChild(el);
    cleanup = bindUserScrollGestures(el);
  });

  afterEach(() => {
    cleanup();
    el.remove();
    vi.restoreAllMocks();
  });

  it("does not mark the reader hot when the transcript scrolls itself", () => {
    // Exactly what the follow effect does, then the event the browser fires.
    el.scrollTop = 999_999;
    el.dispatchEvent(new Event("scroll"));
    expect(isScrollHot()).toBe(false);
  });

  it("marks the reader hot on a real wheel gesture", () => {
    el.dispatchEvent(new Event("wheel"));
    expect(isScrollHot()).toBe(true);
  });

  it("marks the reader hot on touch scrolling", () => {
    expect(isScrollHot()).toBe(false);
    el.dispatchEvent(new Event("touchmove"));
    expect(isScrollHot()).toBe(true);
  });

  it("goes cold once the gesture stops", () => {
    el.dispatchEvent(new Event("wheel"));
    expect(isScrollHot()).toBe(true);
    advance(200);
    expect(isScrollHot()).toBe(false);
  });

  it("stops listening after cleanup", () => {
    cleanup();
    el.dispatchEvent(new Event("wheel"));
    expect(isScrollHot()).toBe(false);
  });
});
