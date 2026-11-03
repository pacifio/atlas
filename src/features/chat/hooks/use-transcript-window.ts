// The transcript's window: which rows are mounted, and where the reader is.
//
// Lifted out of `transcript.tsx` verbatim; the long notes there and here are
// the design. Grows UPWARD in idle slices, re-anchors every prepend in the same
// frame, lands a reopened session on its last user turn, holds the reader's
// row while markdown settles, and follows the live edge. Every effect runs in
// the order the component declared it, which is what the scroll contract
// depends on.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { isScrollHot } from "@/lib/scroll-hot";
import { RowKind, type Row } from "../lib/turn-rows";
import { useTranscriptScroll } from "../lib/use-transcript-scroll";
import { TOP_BLUR_RAMP } from "../lib/transcript-insets";

/**
 * How many rows are added each time the window grows.
 *
 * Sized in ROWS, not turns: a collapsed tool sequence counts as one row, and an
 * opened one counts as one row carrying its calls (26px each, laid out in the
 * thread rather than in a nested scroller). Forty rows stay ahead of the reader
 * without mounting the full history at once.
 * Bursting 80 at once was visibly worse even after the blank was fixed.
 */
const WINDOW_CHUNK = 40;

/** The window starts larger than it grows: the first paint must overfill the
 *  viewport or the reader lands on a short document and can't scroll. */
const WINDOW_INITIAL = 80;

/** Rows added per idle slice while filling the window in the background.
 *  Larger than the scroll-triggered chunk — idle time is the cheap time. */
const IDLE_CHUNK = 120;

/** Above this many rows the window is filled on demand rather than eagerly.
 *  Mounting tens of thousands of rows to avoid a rare prepend is a bad trade;
 *  below it, a whole thread is comparable to what the Session timeline already
 *  renders happily. */
const MAX_IDLE_FILL = 4000;

/** Writing this to `scrollTop` clamps to the real maximum without ever reading
 *  `scrollHeight` — reading it forces a synchronous layout, and the live-edge
 *  follow runs on every streaming frame, which made that read the one forced
 *  reflow in an otherwise read-free scroll path. */
export const SCROLL_BOTTOM = 1 << 30;

/** Gap left above an anchored row, so it doesn't sit flush against the top. */
const ANCHOR_GAP = 24;
/** The ring a comment jump leaves on the row it landed on, and for how long.
 *  Same treatment as the Timeline's `landed` row. */
// `ring-inset`: a ring is a box-shadow, drawn OUTSIDE the box by default. The
// content column fills the transcript's width once the pane is narrower than
// the reading measure (the overview rail open does it), and an outer ring then
// sat past the scroller's edges — clipped on both sides, top and bottom only.
const LANDED_CLASSES = ["ring-1", "ring-inset", "ring-[var(--atlas-border-strong)]", "rounded-lg"];
const LANDED_MS = 2_000;

/** How long the sticky anchor keeps correcting after a load. Long enough for a
 *  screenful of markdown to finish parsing, short enough that it can never be
 *  mistaken for the transcript refusing to scroll. Any input releases it
 *  immediately regardless. */
const STICKY_SETTLE_MS = 4000;

/** Per (tab, session) scroll position, so switching away and back returns the
 *  reader where they were. Stores the window start too — a scrollTop means
 *  nothing without the window it was measured in. */
interface Saved {
  startIndex: number;
  scrollTop: number;
  atEnd: boolean;
}
const savedScroll = new Map<string, Saved>();
/** Bound the cache: entries for closed tabs / dead sessions have no eviction
 *  hook here, so cap it FIFO — re-inserting on unmount refreshes recency
 *  (Map iteration order), keeping live tabs safe from eviction. */
const SAVED_SCROLL_CAP = 100;
function saveScroll(cacheKey: string, saved: Saved): void {
  savedScroll.delete(cacheKey);
  savedScroll.set(cacheKey, saved);
  if (savedScroll.size > SAVED_SCROLL_CAP) {
    const oldest = savedScroll.keys().next().value;
    if (oldest !== undefined) savedScroll.delete(oldest);
  }
}

export interface TranscriptWindowInput {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  rows: Row[];
  /** Showing and caught up (`useThawed`): the only state the window moves in. */
  live: boolean;
  /** `${tabId}:${acpSessionId}` — the saved-scroll and session-switch key. */
  cacheKey: string;
  topInset: number;
  /** The working indicator is showing (it changes height without changing
   *  the row count). */
  working: boolean;
  onShowJumpChange?: (visible: boolean, newCount?: number) => void;
}

export interface TranscriptWindow {
  setStartIndex: Dispatch<SetStateAction<number>>;
  /** `startIndex`, corrected for a projection that shrank. Render from this. */
  safeStart: number;
  visible: Row[];
  /** Content below the viewport (the jump pill and the bottom fade). */
  more: boolean;
  onScroll: () => void;
  /** A row id to bring to the top of the viewport once it has rendered. */
  pendingAnchorRef: RefObject<string | null>;
  /** Row ids a comment jump wants lit, first one in the DOM wins. */
  pendingHighlightRef: RefObject<string[] | null>;
  lastSeenLen: RefObject<number>;
  setNewCount: Dispatch<SetStateAction<number>>;
}

export function useTranscriptWindow({
  scrollRef,
  contentRef,
  rows,
  live,
  cacheKey,
  topInset,
  working,
  onShowJumpChange,
}: TranscriptWindowInput): TranscriptWindow {
  // ── The window ───────────────────────────────────────────────────────
  // Anchored by START INDEX, not by a count back from the end. A count would
  // slide the window forward as the agent streams, dropping rows off the top
  // and shifting the content under a reader who is scrolled up in history.
  const [startIndex, setStartIndex] = useState(() => Math.max(0, rows.length - WINDOW_INITIAL));

  // A projection that SHRINKS — "New chat" resetting the session in place, a
  // project switch dropping history — leaves `startIndex`
  // pointing into a thread that no longer exists. Every other writer only ever
  // moves the start DOWN (growth, jump-to-message) or sets it to this floor, so
  // a start above the floor is unreachable except by a shrink: that is the
  // signal, and it is exact.
  //
  // Snapping back to a full window is the whole fix. Clamping to `rows.length
  // - 1` (what this did before) turned the empty slice into a transcript
  // showing exactly ONE row — nothing above it, nothing below the fold, so the
  // jump-to-bottom pill stayed hidden too. That reads as "the thread stopped
  // updating mid-turn", and it clears the moment anything remounts the
  // component (switching project and back), which is what made it look like a
  // stuck agent rather than a windowing bug.
  const windowFloor = Math.max(0, rows.length - WINDOW_INITIAL);
  const stale = startIndex > windowFloor;
  const safeStart = stale ? windowFloor : startIndex;
  const visible = useMemo(() => rows.slice(safeStart), [rows, safeStart]);
  const canGrow = safeStart > 0;

  // Fold the correction back into state. Rendering from `safeStart` alone
  // would leave `startIndex` stale, and the idle fill keys off `startIndex` —
  // it would spend its slices walking a value that no longer refers to
  // anything, never reaching 0, so the window would stop filling.
  useEffect(() => {
    if (stale) setStartIndex(safeStart);
  }, [stale, safeStart]);

  const onGrow = useCallback(() => {
    growPendingRef.current = true;
    setStartIndex((i) => Math.max(0, i - WINDOW_CHUNK));
  }, []);

  // ── Sticky anchor: hold the reader's place while content settles ─────
  //
  // Loading a session mounts a screen of messages whose markdown is still
  // being parsed. Each one swaps from its raw-text placeholder to formatted
  // HTML at a slightly different height, and every swap above the viewport
  // pushes everything below it — the thread visibly creeps while it settles.
  // Priority parsing decides WHICH message formats first; this decides that it
  // does not move the reader when it does.
  //
  // The anchor is a ROW, not a scroll offset: offsets are exactly what the
  // reflow invalidates. Re-holding `offsetTop` (measured from the positioned
  // ancestor, so independent of scroll) puts the row back where it was.
  const stickyRef = useRef<{ rowId: string; offset: number } | null>(null);
  const stickyUntil = useRef(0);
  /** True between asking to grow and the re-anchor landing. */
  const growPendingRef = useRef(false);

  const onContentResize = useCallback(() => {
    const sticky = stickyRef.current;
    const el = scrollRef.current;
    if (!sticky || !el) return;
    // A prepend is in flight — its own re-anchor is authoritative and runs in
    // a layout effect; two corrections in one frame fight each other.
    if (growPendingRef.current) return;
    if (performance.now() > stickyUntil.current) {
      stickyRef.current = null;
      return;
    }
    const node = el.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(sticky.rowId)}"]`);
    if (!node) return;
    const target = Math.max(0, node.offsetTop - sticky.offset);
    if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target;
  }, []);

  /**
   * Row the reader is looking at when a grow starts, plus how far below the
   * viewport top it sat. Restoring against THIS rather than a distance from
   * the bottom is what stops the thread creeping upward while newly-prepended
   * markdown resolves — see the note in `use-transcript-scroll.ts`.
   */
  const growAnchorRow = useRef<{ rowId: string; offset: number } | null>(null);

  const captureGrowAnchor = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const top = el.scrollTop;
    // Binary search the content's direct children for the first row whose top
    // is at or below the viewport top — the row the reader's eye is anchored
    // on. Children are in document order so `offsetTop` is monotonic. This
    // runs on every idle-fill step; the old querySelectorAll walk visited
    // every row above the viewport per step, which compounds to O(rows²/chunk)
    // while filling a long thread.
    const kids = content.children;
    let lo = 0;
    let hi = kids.length - 1;
    let found: HTMLElement | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const node = kids[mid];
      if (!(node instanceof HTMLElement)) break;
      if (node.offsetTop - top >= 0) {
        found = node;
        hi = mid - 1;
      } else {
        // Row straddling the top edge — the fallback if nothing sits below.
        if (!found) found = node;
        lo = mid + 1;
      }
    }
    growAnchorRow.current =
      found && found.dataset.rowId !== undefined
        ? { rowId: found.dataset.rowId, offset: found.offsetTop - top }
        : null;
  }, []);

  const { more, onScroll, invalidate, atEndRef, growPending } = useTranscriptScroll({
    scrollRef,
    contentRef,
    canGrow,
    onGrow,
    onBeforeGrow: captureGrowAnchor,
    onContentResize,
    visible: live,
  });

  // ── Fill the window during IDLE, not during scroll ───────────────────
  //
  // This is the difference between this list and the Session timeline, and it
  // is why the timeline never flickers. The timeline only ever APPENDS, below
  // the fold, where nothing the reader is looking at moves. A chat window
  // grows at the top, so every growth PREPENDS — the document gets taller
  // above the viewport and the scroll position has to be rebuilt to
  // compensate. Doing that on the frame the reader is mid-flick is what
  // produced the blanks: for one frame the rows exist but the scroll position
  // still refers to the old geometry.
  //
  // So don't grow on scroll if we can avoid it. Expand the window in the gaps
  // between frames instead, until the whole thread is mounted; by the time the
  // reader scrolls up, the rows are already there and no prepend happens at
  // all. `requestIdleCallback` yields to scrolling by construction, so this
  // cannot compete with the gesture. The scroll-triggered growth stays as a
  // fallback for a reader who outruns it.
  useEffect(() => {
    if (startIndex === 0) return;
    // Very long threads keep the on-demand path: mounting tens of thousands of
    // rows to save a rare prepend is a bad trade.
    if (rows.length > MAX_IDLE_FILL) return;
    // Hidden tab: don't fill. A chat stays mounted behind whichever tab is
    // showing (kept laid out, see the chat wrapper in `center-panel.tsx`), so
    // every chunk mounted here would cost DOM and layout in a panel nobody can
    // see — and a never-visited tab that stays at its initial window is what
    // keeps that wrapper cheap. The effect re-runs when the tab shows, so the
    // fill resumes in idle slices and never lands on the switch frame.
    if (!live) return;

    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number;
      cancelIdleCallback?: (h: number) => void;
    };
    let idle: number | null = null;
    let timer: number | null = null;

    const step = () => {
      idle = null;
      timer = null;
      // Mid-gesture: back off. The rIC `timeout: 400` below silently broke
      // this effect's founding promise ("requestIdleCallback yields to
      // scrolling by construction") — it FORCES the step to run during a
      // long fling, and mounting IDLE_CHUNK rows stalls the main thread
      // 100-300ms while WKWebView's compositor keeps scrolling on its own
      // thread into unpainted territory. That is the black-viewport blanking,
      // no streaming required. Resume a beat after the gesture goes quiet.
      if (isScrollHot()) {
        timer = window.setTimeout(step, 180);
        return;
      }
      // A scroll-triggered grow is already in flight — let it land first, or
      // the two overwrite each other's anchor.
      if (growPending.current) return;
      growPending.current = true;
      captureGrowAnchor();
      growPendingRef.current = true;
      setStartIndex((i) => Math.max(0, i - IDLE_CHUNK));
    };

    if (typeof w.requestIdleCallback === "function") {
      idle = w.requestIdleCallback(step, { timeout: 400 });
    } else {
      timer = window.setTimeout(step, 100);
    }
    return () => {
      if (idle !== null && typeof w.cancelIdleCallback === "function") {
        w.cancelIdleCallback(idle);
      }
      if (timer !== null) window.clearTimeout(timer);
    };
    // Re-runs on each `startIndex` change, which is what drives the loop
    // forward one chunk per idle slice until the window covers everything.
  }, [startIndex, rows.length, growPending, captureGrowAnchor, live]);
  // Re-anchor after growing upward: put the recorded row back under the same
  // pixel. Layout effect, so the correction lands in the same frame and is
  // never seen.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = growAnchorRow.current;
    if (!el || !anchor) return;
    const node = el.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(anchor.rowId)}"]`);
    if (node) el.scrollTop = Math.max(0, node.offsetTop - anchor.offset);
    growAnchorRow.current = null;
    growPending.current = false;
    growPendingRef.current = false;
    invalidate();
  }, [startIndex, growPending, invalidate]);

  // ── Session switch: reset the window, land on the last user turn ─────
  /** A row id to bring to the top of the viewport once it has rendered. */
  const pendingAnchorRef = useRef<string | null>(null);
  const settledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    // Frozen rows belong to the PREVIOUS session here. A hidden tab can change
    // `cacheKey` under us (a rebind mints a new acpSessionId, "New chat"
    // resets in place), and settling against the stale row set would both
    // anchor to a row that is about to disappear and mark this session as
    // already settled — so the real content would land unanchored. Wait for
    // the catch-up; `live` is in the deps, so this runs the moment it does.
    if (!live) return;
    if (settledFor.current === cacheKey) return;
    if (rows.length === 0) return;
    settledFor.current = cacheKey;

    const saved = savedScroll.get(cacheKey);
    if (saved && !saved.atEnd) {
      setStartIndex(saved.startIndex);
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = saved.scrollTop;
      });
      return;
    }

    // Reopening lands on the LAST USER TURN, not the absolute bottom: the
    // reader needs to see what they asked with the answer starting below it.
    // Widen the window if that turn falls outside it.
    let lastUser = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === RowKind.User || rows[i].kind === RowKind.Injected) {
        lastUser = i;
        break;
      }
    }
    const start = Math.max(0, Math.min(lastUser, rows.length - WINDOW_INITIAL));
    setStartIndex(start);
    pendingAnchorRef.current = lastUser >= 0 ? rows[lastUser].id : null;
  }, [cacheKey, rows, live]);

  // A jump from the comments panel names the row to light up once the turn is
  // on screen — the row itself when it is in the DOM (a response, a prompt),
  // else the "Worked" header hiding it. Applied imperatively: the ring is a
  // two-second decoration, not row state, and routing it through the memoized
  // row list would re-render every mounted row for it.
  const pendingHighlightRef = useRef<string[] | null>(null);
  const landedRef = useRef<{ node: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(
    null,
  );
  const markLanded = useCallback((row: HTMLElement) => {
    // The ring goes on the row's content column, not the full-width wrapper
    // — the same footprint the Timeline's landed entry has.
    const node = (row.firstElementChild as HTMLElement | null) ?? row;
    const prev = landedRef.current;
    if (prev) {
      clearTimeout(prev.timer);
      prev.node.classList.remove(...LANDED_CLASSES);
    }
    node.classList.add(...LANDED_CLASSES);
    landedRef.current = {
      node,
      timer: setTimeout(() => {
        node.classList.remove(...LANDED_CLASSES);
        landedRef.current = null;
      }, LANDED_MS),
    };
  }, []);
  useEffect(() => () => void (landedRef.current && clearTimeout(landedRef.current.timer)), []);

  useLayoutEffect(() => {
    const id = pendingAnchorRef.current;
    if (!id) return;
    const el = scrollRef.current;
    const node = el?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (!el || !node) return;
    pendingAnchorRef.current = null;
    let landed: HTMLElement | null = null;
    const wanted = pendingHighlightRef.current;
    if (wanted) {
      pendingHighlightRef.current = null;
      for (const rowId of wanted) {
        landed = el.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`);
        if (landed) break;
      }
    }
    const anchor = landed ?? node;
    // Clear the floating header and its blur band, not just the scroller's
    // edge: a gap of `ANCHOR_GAP` alone parked the landed row under the bar,
    // blurred. With a header the gap is the content's own top padding, so a
    // jump to the first row lands exactly where it rests.
    const gap = topInset ? topInset + TOP_BLUR_RAMP + 12 : ANCHOR_GAP;
    // `offsetTop` is measured from the positioned ancestor, so it is
    // independent of the current scroll position.
    el.scrollTop = Math.max(0, anchor.offsetTop - gap);
    // Hold this row in place while the screenful of markdown around it
    // finishes parsing. Without this the reader watches the thread creep as
    // each block swaps from placeholder to formatted.
    stickyRef.current = { rowId: anchor.dataset.rowId ?? id, offset: gap };
    stickyUntil.current = performance.now() + STICKY_SETTLE_MS;
    invalidate();
    if (landed) markLanded(landed);
  });

  // Any deliberate input means the reader has taken over — stop correcting
  // their position. Same release rule the scroll contract uses everywhere.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const release = () => {
      stickyRef.current = null;
    };
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("touchstart", release, { passive: true });
    el.addEventListener("keydown", release);
    el.addEventListener("mousedown", release);
    return () => {
      el.removeEventListener("wheel", release);
      el.removeEventListener("touchstart", release);
      el.removeEventListener("keydown", release);
      el.removeEventListener("mousedown", release);
    };
  }, []);

  // ── Follow the live edge ─────────────────────────────────────────────
  // One effect. `atEndRef` is maintained by the scroll loop, so this reads no
  // layout to decide, and appends land inside the window by construction
  // (the window is anchored at its start, so it always extends to the end).
  const [newCount, setNewCount] = useState(0);
  const lastSeenLen = useRef(rows.length);
  const tail = rows[rows.length - 1];
  const tailLen =
    tail && (tail.kind === RowKind.Prose || tail.kind === RowKind.Thinking) ? tail.text.length : 0;

  // Layout effect, not effect: running after paint let each append paint one
  // frame at the old position before the correction landed — a per-frame
  // micro-jitter at the live edge. In the same frame, the correction is
  // invisible.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (atEndRef.current) {
      el.scrollTop = SCROLL_BOTTOM;
      lastSeenLen.current = rows.length;
      setNewCount((c) => (c === 0 ? c : 0));
    } else {
      setNewCount(Math.max(0, rows.length - lastSeenLen.current));
    }
    // `working` is in the deps because the indicator mounting and unmounting
    // changes the document height without changing the row count — a reader
    // sitting at the live edge would otherwise drift off it.
  }, [rows.length, tailLen, working, atEndRef]);

  // Clear the unseen count once the reader catches up.
  useEffect(() => {
    if (!more) {
      lastSeenLen.current = rows.length;
      setNewCount((c) => (c === 0 ? c : 0));
    }
  }, [more, rows.length]);

  useEffect(() => {
    onShowJumpChange?.(more, more ? newCount : 0);
  }, [more, newCount, onShowJumpChange]);

  useEffect(() => () => onShowJumpChange?.(false), [onShowJumpChange]);

  // Persist position on unmount so reopening returns the reader. A tab switch
  // no longer unmounts (the panel stays mounted and laid out behind the active
  // tab, keeping `scrollTop` in the DOM); this covers closing the tab or the
  // project and coming back.
  useEffect(() => {
    return () => {
      const el = scrollRef.current;
      if (!el) return;
      saveScroll(cacheKey, {
        startIndex,
        scrollTop: el.scrollTop,
        atEnd: atEndRef.current,
      });
    };
  }, [cacheKey, startIndex, atEndRef]);

  return {
    setStartIndex,
    safeStart,
    visible,
    more,
    onScroll,
    pendingAnchorRef,
    pendingHighlightRef,
    lastSeenLen,
    setNewCount,
  };
}
