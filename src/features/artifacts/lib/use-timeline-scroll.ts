/**
 * The Session timeline's scroll loop, measured once instead of per event.
 *
 * Three things want to know where the reader is: the window (grow when the
 * bottom is near), the bottom fade (is there more below), and the navigation
 * rail (which prompt is at the top). Done naively, each one reads the DOM inside
 * the scroll handler — and `scrollHeight` / `getBoundingClientRect()` are
 * *forced synchronous layouts*. Scroll events fire faster than frames, and one
 * `getBoundingClientRect()` per rail tick per event turns a flick through a long
 * Session into a layout storm.
 *
 * This hook keeps the same answers and pays for them differently:
 *
 * * **Nothing is read in the scroll handler.** It schedules a frame and returns.
 * * **Inside the frame, only `scrollTop` is read** — the one geometry property
 *   that does not invalidate layout.
 * * **Everything else is cached**: content height, viewport height, and each
 *   anchor's offset. They are re-measured only when a `ResizeObserver` says the
 *   content actually changed size — which is exactly when they can go stale
 *   (the window grew, a tool call opened, a `Show more` expanded) and never
 *   merely because someone scrolled.
 *
 * The remeasure itself happens inside the same frame as the reads, so a dirty
 * pass is one layout for the whole set rather than one per anchor.
 *
 * State is published only on *change*, so a scroll that moves the reader within
 * one prompt re-renders nothing at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

/** How close to the bottom (px) the window grows at. */
const GROW_MARGIN = 600;

/** Slack (px) below which "there is more" reads as "you are at the bottom". */
const AT_BOTTOM = 24;

/**
 * How far below the viewport top a prompt may sit and still count as the one
 * being read. Matches the rail's own sense of "current".
 */
const ANCHOR_SLACK = 8;

interface TimelineScroll {
  /** True while content extends below the fold — drives the bottom fade. */
  more: boolean;
  /** Index into the anchor list of the prompt at the top of the viewport. */
  activeAnchor: number;
  /** Attach to the scroll container's `onScroll`. */
  onScroll: () => void;
  /**
   * Force a re-measure on the next frame.
   *
   * For height changes a `ResizeObserver` cannot see — a filter that swaps the
   * whole list keeps the same scroll element and may land on the same height.
   */
  invalidate: () => void;
}

export function useTimelineScroll({
  scrollRef,
  contentRef,
  anchorRefs,
  anchorCount,
  canGrow,
  onGrow,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  /** The scrolled content, watched for size changes. */
  contentRef: RefObject<HTMLElement | null>;
  /** Rail index → live node, maintained by the list. */
  anchorRefs: RefObject<Map<number, HTMLElement>>;
  /** Re-measure when this changes: the set of anchors was rebuilt. */
  anchorCount: number;
  /** Whether there is anything left to reveal. */
  canGrow: boolean;
  onGrow: () => void;
}): TimelineScroll {
  const [more, setMore] = useState(false);
  const [activeAnchor, setActiveAnchor] = useState(0);

  const frame = useRef<number | null>(null);
  const dirty = useRef(true);
  /** Cached geometry. Valid until the content resizes. */
  const metrics = useRef({ scrollHeight: 0, clientHeight: 0, offsets: [] as number[] });

  // Held in refs so the scroll callback never has to be rebuilt — a new handler
  // identity on every render means React detaching and re-attaching the
  // listener, which is pure churn in the one path that must stay cheap.
  const growable = useRef(canGrow);
  growable.current = canGrow;
  const grow = useRef(onGrow);
  grow.current = onGrow;

  const invalidate = useCallback(() => {
    dirty.current = true;
  }, []);

  // The anchor set changed identity — the cached offsets describe the old one.
  useEffect(invalidate, [anchorCount, invalidate]);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const offsets: number[] = [];
    const map = anchorRefs.current;
    if (map) {
      // `offsetTop` rather than `getBoundingClientRect()`: it is measured from
      // the positioned ancestor, not the viewport, so it is independent of the
      // scroll position and stays valid for as long as the layout does.
      for (const [index, node] of map) offsets[index] = node.offsetTop;
    }
    metrics.current = {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      offsets,
    };
    dirty.current = false;
  }, [scrollRef, anchorRefs]);

  const sample = useCallback(() => {
    frame.current = null;
    const el = scrollRef.current;
    if (!el) return;
    if (dirty.current) measure();

    // The only read on a clean pass, and the only one that never forces layout.
    const top = el.scrollTop;
    const { scrollHeight, clientHeight, offsets } = metrics.current;
    const fromBottom = scrollHeight - top - clientHeight;

    if (growable.current && fromBottom <= GROW_MARGIN) grow.current();
    setMore(fromBottom > AT_BOTTOM);

    let active = 0;
    for (let i = 0; i < offsets.length; i++) {
      if (offsets[i] !== undefined && offsets[i] - top <= ANCHOR_SLACK) active = i;
      else break; // offsets ascend, so the first miss ends the search
    }
    setActiveAnchor((prev) => (prev === active ? prev : active));
  }, [scrollRef, measure]);

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(sample);
  }, [sample]);

  // Content height changes invalidate every cached number, and they happen for
  // reasons that have nothing to do with scrolling: the window grew, a tool call
  // opened, a clamped body expanded. Observing the element is the only way to
  // catch all of them without re-measuring on a timer.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const observer = new ResizeObserver(() => {
      dirty.current = true;
      // Re-sample rather than only marking dirty: growing the window makes the
      // page taller *without* a scroll event, and the fade would keep saying
      // "you are at the bottom" until the reader moved.
      if (frame.current === null) frame.current = requestAnimationFrame(sample);
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [contentRef, scrollRef, sample]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return useMemo(
    () => ({ more, activeAnchor, onScroll, invalidate }),
    [more, activeAnchor, onScroll, invalidate],
  );
}
