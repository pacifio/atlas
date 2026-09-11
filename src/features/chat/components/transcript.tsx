// The transcript: a windowed list of real DOM rows.
//
// **Not virtualized, on purpose.** A virtualizer was tried here first and lost
// to the Session timeline on the only test that matters — scrolling it — despite
// the timeline rendering far heavier rows. Two reasons, both measured rather
// than reasoned:
//
//  1. **Blanking.** Unmounting offscreen rows means a fast flick outruns React's
//     ability to mount the ones arriving, and the reader watches empty space.
//     Raising overscan only moves the speed at which it happens. A row that is
//     already in the DOM cannot blank.
//  2. **Scroll cost.** A virtualizer has to know where everything is on every
//     scroll. The windowed approach asks nothing on scroll: the browser scrolls
//     a plain document, which is the operation it is most optimized for.
//
// So this mirrors `session-detail.tsx`: render a window of real rows and grow it
// as the reader approaches its edge, with `use-transcript-scroll.ts` keeping the
// scroll loop free of forced layout.
//
// The window grows UPWARD (chat is read newest-first), which the timeline never
// has to handle — see the re-anchoring in `useLayoutEffect` below.
//
// Because rows are real DOM, nothing here predicts heights. The whole
// predicted-height apparatus the virtualized version needed — a height
// function, canvas text measurement, a dev drift assertion — is gone.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ChatMessage } from "@/types/agent";
import {
  agentMeta,
  catalogEntry as agentCatalogEntry,
  switchableAgentOf,
} from "@/features/agents/lib/agent-meta";
import { useIsTabVisible } from "@/features/layout/lib/use-tab-visible";
import { projectRows, RowKind, type Projection, type Row } from "../lib/turn-rows";
import { useTranscriptScroll } from "../lib/use-transcript-scroll";
import { useThawed } from "../lib/use-thawed";
import { useChatStore } from "../stores/chat-store";
import { saveThreadToKb } from "../lib/turn-actions";
import { sessionCanRetry } from "../lib/retry-gate";
import { pinScope } from "../stores/chat-pins-store";
import { cn } from "@/lib/utils";
import { isScrollHot } from "@/lib/scroll-hot";
import { GradualBlur } from "@/components/gradual-blur";
import { LoadingState } from "./loading-state";
import {
  UserRowView,
  ProseRowView,
  ThinkingRowView,
  MarkerRowView,
  MarkerGroupRowView,
  SeparatorRowView,
  TurnFooterRowView,
} from "./transcript-rows";

/**
 * How many rows are added each time the window grows.
 *
 * Sized in ROWS, not turns: a tool-heavy turn is a dozen 24px markers, so 40
 * rows is a couple of turns — enough to stay ahead of the reader, small enough
 * that mounting them (and parsing whatever markdown they carry) is not a hitch.
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
const SCROLL_BOTTOM = 1 << 30;

/** How far the header's blur band ramps BELOW the bar. Content must clear this
 *  too, or the first message renders permanently blurred. */
const TOP_BLUR_RAMP = 34;

/** Gap left above an anchored row, so it doesn't sit flush against the top. */
const ANCHOR_GAP = 24;

/** Breathing room between the last row and the composer. Applied as content
 *  padding rather than a spacer element so it scrolls with the thread and the
 *  bottom fade still has live content to dissolve into. */
const BOTTOM_GAP = 28;

/** How long the sticky anchor keeps correcting after a load. Long enough for a
 *  screenful of markdown to finish parsing, short enough that it can never be
 *  mistaken for the transcript refusing to scroll. Any input releases it
 *  immediately regardless. */
const STICKY_SETTLE_MS = 4000;

/** Shared with the composer — see `switchableAgentOf`. */
const switchable = switchableAgentOf;

export interface TranscriptHandle {
  scrollToBottom: () => void;
  scrollToMessage: (messageIndex: number) => void;
}

interface TranscriptProps {
  tabId: string;
  acpSessionId: string;
  messages: ChatMessage[];
  isStreaming: boolean;
  agentType?: string;
  /** Vertical space (px) reserved at the top for the floating header, applied as
   *  content padding so the first row clears it while still scrolling under. */
  topInset?: number;
  onShowJumpChange?: (visible: boolean, newCount?: number) => void;
  /** What the working indicator says while the session is still binding and
   *  the first message is held (see `ChatSession.pendingSend`) — "Starting
   *  Claude Code" rather than "Thinking", which would claim a turn that has
   *  not been dispatched yet. */
  workingLabel?: string;
}

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

/**
 * Shown while a turn is live but has produced nothing to render yet: the ACP
 * round-trip, the model's first tokens, the beat before the first tool call.
 * Without it the transcript sits completely unchanged after send, which reads
 * as the message having been dropped.
 *
 * A pixel-grid wavefront, a shimmering label and an elapsed timer rather than a
 * spinner — see `loading-state.tsx` and the shimmer's note in `globals.css`.
 * The timer matters here specifically: this is the one moment in a turn with no
 * other evidence that anything is happening, and "42.4s" answers the question
 * the reader is actually asking. It occupies a fixed-height row so its arrival
 * and departure don't jolt the thread it sits under.
 */
function WorkingIndicator({ label = "Thinking" }: { label?: string }) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 pt-2 pb-3">
      <LoadingState label={label} />
    </div>
  );
}

export const Transcript = forwardRef<TranscriptHandle, TranscriptProps>(function Transcript(
  {
    tabId,
    acpSessionId,
    messages,
    isStreaming,
    agentType,
    topInset = 0,
    onShowJumpChange,
    workingLabel,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cacheKey = `${tabId}:${acpSessionId}`;
  const pinScopeKey = pinScope(tabId, acpSessionId);
  const agent = switchable(agentType);
  // Is this tab the one showing in its column? Boolean selector: flips only
  // for the two tabs involved in a switch. Gates the idle window fill below.
  const tabVisible = useIsTabVisible(tabId);

  // ── Frozen while hidden ──────────────────────────────────────────────
  //
  // A hidden chat tab stays MOUNTED AND LAID OUT (`visibility:hidden` — see
  // the chat wrapper in `center-panel.tsx`), which is what makes switching
  // back to a long thread instant. The cost is that everything below here
  // would otherwise keep running for a thread nobody can see: a streaming
  // background chat re-projects its rows, re-parses its live tail, appends
  // DOM, fires the ResizeObserver and writes `scrollTop` — several times a
  // second, on the same main thread the VISIBLE transcript is scrolling.
  // That is frame budget spent on nothing, and it lands in exactly the frames
  // a fling cannot spare.
  //
  // So a hidden transcript is FROZEN: it keeps rendering the last row set it
  // had while visible and ignores every message that arrives meanwhile. The
  // panel around it stays live (its own store subscription drives the title,
  // the status pill, notifications, queued sends) — only the row list stops.
  //
  // `useThawed` is the second half, and it is about WHEN the catch-up lands:
  // one frame after the tab shows, never on the switch frame itself.
  /** Showing AND caught up — the only state in which this transcript moves. */
  const live = useThawed(tabVisible);

  // Only the just-sent user message plays the bubble entrance (id-scoped —
  // see UserRowView). Primitive selector: changes once per user send.
  const justSentMessageId = useChatStore((s) => s.sessions[tabId]?.justSentMessageId);
  // A send that landed while this tab was hidden has no entrance to play. The
  // row mounts on the catch-up render, one frame after the switch, and a
  // filled opacity animation there is both a lie (the message is not new to
  // the thread, only to the DOM) and a fresh compositing layer in the frame
  // right after the most expensive one. Recording the id as consumed while
  // hidden is enough — the entrance is a one-shot either way.
  const consumedJustSent = useRef<string | undefined>(justSentMessageId);
  if (!live) consumedJustSent.current = justSentMessageId;
  const entranceMessageId =
    justSentMessageId === consumedJustSent.current ? undefined : justSentMessageId;
  const { label: agentLabel } = agentMeta(agent);

  // Whether a retry is possible RIGHT NOW. Selector returns a boolean and is
  // O(1), so it runs on every store write but re-renders only when the answer
  // flips — the same bargain as `justSentMessageId` above. Doing this per-row
  // instead, or selecting the session object, would put a comparison of the
  // whole session on every streaming frame.
  // Discovered, not inferred from the agent id (ADR-0002) — the same catalog
  // flag `supportsFork` uses, computed from the live connection.
  const supportsRewind = agentCatalogEntry(agent)?.supportsRewind === true;
  const canRetry = useChatStore((s) => sessionCanRetry(s.sessions[tabId], supportsRewind));

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** Turns whose tool-call block the reader has opened. */
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const toggleTurn = useCallback((turnId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  }, []);
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Previous projection, threaded back in for structural sharing: rows that
  // didn't change come back as the SAME objects, so the memo'd row views hold
  // per streaming frame instead of re-rendering the whole mounted window.
  //
  // It doubles as the freeze store. Returning it unchanged while `!live` is
  // the entire mechanism: `rows`, `visible`, `working` and `tailLen` all
  // derive from here, so holding one object still holds the window, the
  // live-edge follow, the session-switch anchor and the row elements
  // themselves. The projection pass never runs for a hidden thread, and the
  // one it eventually runs on catch-up shares structure with this same
  // object — so the rows that did not change while hidden come back
  // identical and never re-render.
  const prevProjectionRef = useRef<Projection | null>(null);
  const projection = useMemo(() => {
    if (!live && prevProjectionRef.current) return prevProjectionRef.current;
    const next = projectRows(
      messages,
      { expanded, expandedTurns, streaming: isStreaming },
      prevProjectionRef.current,
    );
    prevProjectionRef.current = next;
    return next;
  }, [messages, expanded, expandedTurns, isStreaming, live]);
  const rows: Row[] = projection.rows;

  // ── Is the live turn still silent? ───────────────────────────────────
  // A streaming assistant message only becomes a turn once it emits at least
  // one row, so "the thread does not end in an assistant turn while streaming"
  // is exactly the window between hitting send and the first thing appearing.
  // Derived from the projection rather than tracked separately, so it cannot
  // drift out of step with what is actually on screen.
  const lastTurn = projection.turns[projection.turns.length - 1];
  const working = isStreaming && (!lastTurn || lastTurn.role !== "assistant");

  // ── The window ───────────────────────────────────────────────────────
  // Anchored by START INDEX, not by a count back from the end. A count would
  // slide the window forward as the agent streams, dropping rows off the top
  // and shifting the content under a reader who is scrolled up in history.
  const [startIndex, setStartIndex] = useState(() => Math.max(0, rows.length - WINDOW_INITIAL));

  // A projection that SHRINKS — "New chat" resetting the session in place, a
  // workspace switch dropping history, a role filter — leaves `startIndex`
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
  // Retry belongs to the thread's LAST user message, which is a fact about the
  // session's history — not about which row happens to be last in the DOM (an
  // assistant turn projects to several rows, and the window may be truncated
  // at the top). Recomputed only when the projection changes.
  const lastUserRowId = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === RowKind.User) return rows[i].id;
    }
    return undefined;
  }, [rows]);
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
      if (rows[i].kind === RowKind.User) {
        lastUser = i;
        break;
      }
    }
    const start = Math.max(0, Math.min(lastUser, rows.length - WINDOW_INITIAL));
    setStartIndex(start);
    pendingAnchorRef.current = lastUser >= 0 ? rows[lastUser].id : null;
  }, [cacheKey, rows, live]);

  useLayoutEffect(() => {
    const id = pendingAnchorRef.current;
    if (!id) return;
    const el = scrollRef.current;
    const node = el?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (!el || !node) return;
    pendingAnchorRef.current = null;
    // `offsetTop` is measured from the positioned ancestor, so it is
    // independent of the current scroll position.
    el.scrollTop = Math.max(0, node.offsetTop - ANCHOR_GAP);
    // Hold this row in place while the screenful of markdown around it
    // finishes parsing. Without this the reader watches the thread creep as
    // each block swaps from placeholder to formatted.
    stickyRef.current = { rowId: id, offset: ANCHOR_GAP };
    stickyUntil.current = performance.now() + STICKY_SETTLE_MS;
    invalidate();
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
  // workspace and coming back.
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

  // ── Imperative handle + external jumps ───────────────────────────────
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = SCROLL_BOTTOM;
    lastSeenLen.current = rowsRef.current.length;
    setNewCount(0);
  }, []);

  // A jump has two ways of arriving before it can be honoured, and both used
  // to be silently dropped:
  //
  //  * The target row is ALREADY in the window. `setStartIndex` with an
  //    unchanged value schedules no render, so the anchor layout effect never
  //    ran and nothing moved. `jumpTick` exists purely to force that render.
  //  * The caller has just changed the message list (the pin jump clears the
  //    role filter first) and dispatched in the same tick, so the projection
  //    we hold is the OLD one and the index is not in it yet. The index is
  //    parked in `pendingJumpRef` and retried when the projection changes.
  const pendingJumpRef = useRef<number | null>(null);
  const [, setJumpTick] = useState(0);
  const projectionRef = useRef(projection);
  projectionRef.current = projection;

  const tryJump = useCallback(() => {
    const messageIndex = pendingJumpRef.current;
    if (messageIndex === null) return;
    const proj = projectionRef.current;
    const turn = proj.turns.find((t) => t.messageIndex === messageIndex);
    const rowId = turn ? proj.rows[turn.rowStart]?.id : undefined;
    if (!rowId) return;
    const target = rowsRef.current.findIndex((r) => r.id === rowId);
    if (target < 0) return;
    pendingJumpRef.current = null;
    // Widen the window first if the target is above it, then anchor once the
    // row exists. Same settle-over-renders shape the timeline uses for
    // jump-to-Checkpoint.
    setStartIndex((i) => (target < i ? Math.max(0, target - 10) : i));
    pendingAnchorRef.current = rowId;
    setJumpTick((n) => n + 1);
  }, []);

  const scrollToMessage = useCallback(
    (messageIndex: number) => {
      pendingJumpRef.current = messageIndex;
      tryJump();
    },
    [tryJump],
  );

  useEffect(() => {
    if (pendingJumpRef.current !== null) tryJump();
  }, [projection, tryJump]);
  // A jump that never resolved must not fire into the next session's thread.
  useEffect(() => {
    pendingJumpRef.current = null;
  }, [cacheKey]);

  useImperativeHandle(ref, () => ({ scrollToBottom, scrollToMessage }), [
    scrollToBottom,
    scrollToMessage,
  ]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ index: number }>).detail;
      if (typeof detail?.index === "number") scrollToMessage(detail.index);
    };
    window.addEventListener("atlas:chat-jump", handler);
    return () => window.removeEventListener("atlas:chat-jump", handler);
  }, [scrollToMessage]);

  // ── Turn-footer actions ──────────────────────────────────────────────
  const onSaveKb = useCallback(() => void saveThreadToKb(tabId), [tabId]);

  // ── The rows, as one memoized element ────────────────────────────────
  //
  // The row VIEWS are memo'd, but building the list was not: every Transcript
  // render allocated a wrapper element per mounted row — thousands, for a long
  // thread — for React to walk and discard. This component re-renders on every
  // streaming frame of its own session, and (until the freeze above) did so
  // for hidden tabs too. Memoizing the array means React sees the identical
  // element and skips the subtree outright, so a frozen transcript costs
  // nothing per chunk beyond the parent's own render, and a live one only pays
  // for what actually changed.
  //
  // Every dep is either stable by construction (the callbacks, `pinScopeKey`)
  // or changes at most once per turn. `visible` is the projection's own slice,
  // so it holds while the projection does.
  const canRetryRowId = canRetry ? lastUserRowId : undefined;
  const rowViews = useMemo(
    () =>
      visible.map((row, i) => (
        // `group` is the hover scope for the user row's action bar
        // (`user-row-actions.tsx`), which is hidden until the row is hovered.
        // It is the only `group-hover:` selector in the thread, and it is not
        // free — see the fling hover-suspension in `use-transcript-scroll.ts`,
        // which exists specifically to stop it firing for every row that
        // passes under a resting pointer mid-scroll. Don't add a second one.
        <div key={row.id} className="atlas-row group" data-row-id={row.id}>
          <RowView
            row={row}
            tabId={tabId}
            agentLabel={agentLabel}
            justSentMessageId={entranceMessageId}
            onExpandTurn={toggleTurn}
            // Absolute position in the thread, so the newest messages — the
            // ones on screen after a history load — are parsed first. Index
            // within `visible` would shift as the window grows.
            priority={safeStart + i}
            onToggleExpand={toggleExpand}
            onSaveKb={onSaveKb}
            canRetryRowId={canRetryRowId}
            pinScopeKey={pinScopeKey}
          />
        </div>
      )),
    [
      visible,
      safeStart,
      tabId,
      agentLabel,
      entranceMessageId,
      canRetryRowId,
      pinScopeKey,
      toggleTurn,
      toggleExpand,
      onSaveKb,
    ],
  );

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="atlas-transcript h-full overflow-y-auto hide-scrollbar [overflow-anchor:none]"
      >
        {/* Pad past the ENTIRE blur band, not just the bar. Padding by the
              header height alone left the first message sitting inside the
              band's ramp, permanently half-blurred. */}
        <div
          ref={contentRef}
          style={{
            paddingTop: topInset ? topInset + TOP_BLUR_RAMP + 12 : undefined,
            paddingBottom: BOTTOM_GAP,
          }}
        >
          {rows.length === 0 && !isStreaming && (
            <div className="flex h-full items-center justify-center text-[11px] text-[var(--text-tertiary)]">
              No messages yet.
            </div>
          )}
          {rowViews}
          {working && <WorkingIndicator label={workingLabel} />}
        </div>
      </div>

      {/* Progressive blur behind the floating header. It starts at y=0 and
            runs past the bar, so text scrolling underneath is blurred rather
            than clipped by an opaque strip — which is only possible because the
            header does not occupy a row of its own. Sized to the header inset
            plus a short ramp below it. */}
      <GradualBlur
        position="top"
        height={`${topInset + TOP_BLUR_RAMP}px`}
        strength={2.1}
        layers={5}
        // Mostly-opaque behind the bar itself, ramping to clear below it.
        // Without a tint the header read as a transparent pane over live text;
        // `color-mix` keeps it theme-correct rather than hardcoding black.
        tint="color-mix(in srgb, var(--bg-surface) 90%, transparent)"
        style={{ zIndex: 3 }}
      />

      {/* Bottom stays a plain colour fade. The blur was tried here and the
            edge above the composer reads better as a clean dissolve — and it
            avoids a second stack of live backdrop filters over the scroller. */}
      <div
        aria-hidden
        className={cn(
          // `-bottom-[2px]` + 2px extra height: the fade OVERSHOOTS the
          // container edge. At fractional UI scales the fade's bottom and the
          // scroller's bottom can round to different device pixels, and during
          // scroll repaints a 1-2px hairline of text flashed through the seam
          // above the composer. The overshoot is solid bg-surface over the
          // inter-panel gap — invisible, and it absorbs the rounding both ways.
          "pointer-events-none absolute -bottom-[2px] left-0 right-0 z-[1] h-[44px] transition-opacity duration-200",
          more ? "opacity-100" : "opacity-0",
        )}
        style={{
          // The last ~quarter is FULLY solid: a plain two-stop gradient only
          // reaches 100% opacity at the very last pixel, and the ~97%-opaque
          // band just above the composer let white text ghost through the
          // seam (subtle but visible on AMOLED black).
          background:
            "linear-gradient(to bottom, transparent, var(--bg-surface) 72%, var(--bg-surface))",
        }}
      />
    </div>
  );
});

/** Row dispatch. Kept out of the list body so the map stays flat. */
function RowView({
  row,
  justSentMessageId,
  tabId,
  agentLabel,
  priority,
  onToggleExpand,
  onExpandTurn,
  onSaveKb,
  canRetryRowId,
  pinScopeKey,
}: {
  row: Row;
  justSentMessageId?: string;
  tabId: string;
  agentLabel: string;
  priority: number;
  onToggleExpand: (id: string) => void;
  onExpandTurn: (turnId: string) => void;
  onSaveKb: () => void;
  /** Id of the one row allowed to show a retry button, or `undefined` when no
   *  retry is possible. An id compare here keeps `UserRowView`'s prop a plain
   *  boolean. */
  canRetryRowId?: string;
  /** Pin scope for this thread — resolved once here rather than per row, so a
   *  row never reads the chat store. */
  pinScopeKey: string;
}) {
  switch (row.kind) {
    case RowKind.User:
      return (
        <UserRowView
          row={row}
          priority={priority}
          // Row ids are prefixed (`u:<messageId>`); the store records the raw
          // message id. The unprefixed compare never matched — the entrance
          // animation was silently dead until this fix.
          justSent={row.id === `u:${justSentMessageId}`}
          tabId={tabId}
          canRetry={row.id === canRetryRowId}
          pinScopeKey={pinScopeKey}
          onToggleExpand={onToggleExpand}
        />
      );
    case RowKind.Prose:
      return <ProseRowView row={row} agentLabel={agentLabel} priority={priority} />;
    case RowKind.Thinking:
      return <ThinkingRowView row={row} onToggleExpand={onToggleExpand} />;
    case RowKind.Marker:
      return <MarkerRowView row={row} tabId={tabId} />;
    case RowKind.MarkerGroup:
      return <MarkerGroupRowView row={row} onExpandTurn={onExpandTurn} />;
    case RowKind.Separator:
      return <SeparatorRowView row={row} />;
    case RowKind.TurnFooter:
      // made a fresh closure per render and defeated the memo on footer rows.
      return <TurnFooterRowView row={row} onSaveKb={onSaveKb} />;
    default:
      return null;
  }
}
