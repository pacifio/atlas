/**
 * The transcript's scroll loop. A direct port of the Session timeline's
 * `use-timeline-scroll.ts` discipline, inverted for chat.
 *
 * The rule that makes it fast, and the reason the timeline outruns a virtualized
 * list despite rendering far more complex rows:
 *
 *   **Nothing reads layout in the scroll handler.** It schedules a frame and
 *   returns. Inside the frame the only property read is `scrollTop`, which is
 *   the one piece of scroll geometry that does not force a synchronous layout.
 *   Content height and viewport height are cached and re-measured only when a
 *   `ResizeObserver` says they actually changed — which is exactly when they can
 *   go stale (the window grew, an accordion opened) and never merely because
 *   someone scrolled.
 *
 * State is published only on *change*, so a flick that stays within one state
 * re-renders nothing at all.
 *
 * ── What differs from the timeline ──
 *
 * The timeline reads FORWARD: it renders `slice(0, n)` and grows at the bottom,
 * where new rows appear below the fold and disturb nothing. A chat is read
 * BACKWARD — it opens at the newest turn and scrolls up into history — so this
 * window grows at the TOP. Prepending rows moves everything below them, so the
 * caller must re-anchor after a grow; `growAnchor` hands it the invariant to
 * restore (distance from the bottom, which prepending leaves untouched).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

/** How close to the top (px) the window grows at. Generous on purpose: growing
 *  early happens off-screen and is invisible, growing late is a hitch the reader
 *  is looking straight at. */
const GROW_MARGIN = 1400;

/** Slack (px) within which "there is more below" reads as "you are at the end". */
const AT_END = 80;

export interface TranscriptScroll {
  /** True while content extends below the fold — drives the fade + jump pill. */
  more: boolean;
  /** Attach to the scroll container's `onScroll`. */
  onScroll: () => void;
  /** Force a re-measure on the next frame. */
  invalidate: () => void;
  /** Is the reader following the live edge right now? Ref, not state — the
   *  follow effect reads it without re-rendering anything. */
  atEndRef: RefObject<boolean>;
  /** Set true just before a grow; the caller captures its own row anchor and
   *  clears this once it has re-anchored. */
  growPending: RefObject<boolean>;
  /** Fired immediately before the row set grows, so the caller can record which
   *  row the reader is looking at. */
  onBeforeGrow?: () => void;
}

export function useTranscriptScroll({
  scrollRef,
  contentRef,
  canGrow,
  onGrow,
  onBeforeGrow,
  onContentResize,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  /** The scrolled content, watched for size changes. */
  contentRef: RefObject<HTMLElement | null>;
  /** Whether there is any history left to reveal above. */
  canGrow: boolean;
  onGrow: () => void;
  /** Called just before `onGrow`, while the OLD row set is still on screen. */
  onBeforeGrow?: () => void;
  /** Content changed size — the caller may want to re-hold a scroll anchor.
   *  Runs BEFORE the re-sample so the sample sees the corrected position. */
  onContentResize?: () => void;
}): TranscriptScroll {
  const [more, setMore] = useState(false);

  const frame = useRef<number | null>(null);
  const dirty = useRef(true);
  /** Cached geometry. Valid until the content resizes. */
  const metrics = useRef({ scrollHeight: 0, clientHeight: 0 });
  const atEndRef = useRef(true);
  const growPending = useRef(false);

  // Held in refs so the scroll callback never has to be rebuilt — a new handler
  // identity per render means React detaching and re-attaching the listener,
  // which is pure churn in the one path that must stay cheap.
  const growable = useRef(canGrow);
  growable.current = canGrow;
  const grow = useRef(onGrow);
  grow.current = onGrow;
  const beforeGrow = useRef(onBeforeGrow);
  beforeGrow.current = onBeforeGrow;
  const resized = useRef(onContentResize);
  resized.current = onContentResize;

  const invalidate = useCallback(() => {
    dirty.current = true;
  }, []);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    metrics.current = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    dirty.current = false;
  }, [scrollRef]);

  const sample = useCallback(() => {
    frame.current = null;
    const el = scrollRef.current;
    if (!el) return;
    if (dirty.current) measure();

    // The only read on a clean pass, and the only one that never forces layout.
    const top = el.scrollTop;
    const { scrollHeight, clientHeight } = metrics.current;
    const fromBottom = scrollHeight - top - clientHeight;

    // Grow upward well before the reader reaches the top.
    //
    // The caller records WHICH ROW the reader is looking at (`onBeforeGrow`),
    // not a distance. Distance-from-bottom was the obvious invariant and it is
    // wrong here: the rows being prepended are freshly mounted, so their
    // markdown is still resolving from placeholder to formatted for several
    // frames AFTER the re-anchor runs. Every one of those height changes moves
    // the bottom, and the position drifts — which is the upward creep during a
    // history load. A row's `offsetTop` is immune: whatever happens above it,
    // putting that row back under the same pixel is exact.
    //
    // `growPending` also means "no grow in flight": without it a fast scroll
    // fires grow again next frame, before React has committed the previous one.
    if (growable.current && top <= GROW_MARGIN && !growPending.current) {
      growPending.current = true;
      beforeGrow.current?.();
      grow.current();
    }

    const atEnd = fromBottom <= AT_END;
    atEndRef.current = atEnd;
    setMore((prev) => (prev === !atEnd ? prev : !atEnd));
  }, [scrollRef, measure]);

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(sample);
  }, [sample]);

  // Content height changes invalidate every cached number, and they happen for
  // reasons that have nothing to do with scrolling: the window grew, a thinking
  // block opened, a clamped prompt expanded, an image loaded. Observing the
  // element is the only way to catch all of them without polling.
  useEffect(() => {
    const content = contentRef.current;
    const el = scrollRef.current;
    if (!content || !el) return;
    const observer = new ResizeObserver(() => {
      dirty.current = true;
      // Give the caller a chance to re-hold its anchor before anything else
      // looks at the geometry — a markdown block finishing its parse changes
      // heights above the viewport, and without this the reader's position
      // drifts every time one lands.
      resized.current?.();
      // Re-sample rather than only marking dirty: growing the window makes the
      // page taller *without* a scroll event, and the fade would keep saying
      // "you are at the end" until the reader moved.
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
    () => ({ more, onScroll, invalidate, atEndRef, growPending }),
    [more, onScroll, invalidate],
  );
}
