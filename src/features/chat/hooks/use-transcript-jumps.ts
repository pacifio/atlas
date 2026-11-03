// The transcript's jumps: scroll-to-bottom, scroll-to-message, the comment
// panel's fold-opening reveal, the `atlas:chat-jump` event, and the turn rail
// that drives the same jump. Lifted out of `transcript.tsx` verbatim.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Projection, Row } from "../lib/turn-rows";
import { revealStep } from "../lib/jump-reveal";
import {
  deriveTurnRailItems,
  stableTurnRailItems,
  turnRailPreviewSource,
  type TurnRailItem,
} from "../lib/turn-rail";
import { SCROLL_BOTTOM } from "./use-transcript-window";

export interface TranscriptJumpsInput {
  tabId: string;
  cacheKey: string;
  projection: Projection;
  rows: Row[];
  scrollRef: RefObject<HTMLDivElement | null>;
  setStartIndex: Dispatch<SetStateAction<number>>;
  setExpandedTurns: Dispatch<SetStateAction<ReadonlySet<string>>>;
  pendingAnchorRef: RefObject<string | null>;
  pendingHighlightRef: RefObject<string[] | null>;
  lastSeenLen: RefObject<number>;
  setNewCount: Dispatch<SetStateAction<number>>;
}

export function useTranscriptJumps({
  tabId,
  cacheKey,
  projection,
  rows,
  scrollRef,
  setStartIndex,
  setExpandedTurns,
  pendingAnchorRef,
  pendingHighlightRef,
  lastSeenLen,
  setNewCount,
}: TranscriptJumpsInput) {
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
  //  * The caller dispatched in the same tick as a change to the message
  //    list, so the projection
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

  // A jump to a row the projection has folded away (a call inside a collapsed
  // run, anything in a settled turn's "Worked" section) opens those folds
  // first, one per projection, and only then scrolls. Landing on the fold's
  // header instead left a comment's thread unopenable: the row's comment
  // button is not mounted while its fold is shut.
  const pendingRevealRef = useRef<{
    index: number;
    target: string;
    workFoldId: string | undefined;
    highlight: string[];
    steps: number;
  } | null>(null);
  const continueReveal = useCallback(() => {
    const pending = pendingRevealRef.current;
    if (!pending) return;
    const step = revealStep(projectionRef.current.rows, pending.target, pending.workFoldId);
    // Two folds at most (the turn, then the run inside it); the bound only
    // guards against a projection that never shows the row.
    if (step.kind === "open" && pending.steps < 3) {
      pending.steps += 1;
      setExpandedTurns((prev) => new Set(prev).add(step.foldId));
      return; // re-projects; the effect below calls back in
    }
    pendingRevealRef.current = null;
    pendingHighlightRef.current = step.kind === "shown" ? [step.rowId] : pending.highlight;
    scrollToMessage(pending.index);
  }, [scrollToMessage]);
  useEffect(() => {
    if (pendingRevealRef.current) continueReveal();
  }, [projection, continueReveal]);

  // A jump that never resolved must not fire into the next session's thread.
  useEffect(() => {
    pendingJumpRef.current = null;
    pendingRevealRef.current = null;
  }, [cacheKey]);

  // ── Turn rail ────────────────────────────────────────────────────────
  // One tick per user turn. Held stable across streaming frames (see
  // `stableTurnRailItems`), so the memo'd rail re-renders only when a prompt
  // is sent or history loads. The preview reads the latest rows on demand,
  // which keeps the reply's text out of the rail's props entirely.
  const turnRailItemsRef = useRef<readonly TurnRailItem[] | null>(null);
  const turnRailItems = useMemo(() => {
    const next = stableTurnRailItems(turnRailItemsRef.current, deriveTurnRailItems(projection));
    turnRailItemsRef.current = next;
    return next;
  }, [projection]);
  const getTurnRailPreview = useCallback(
    (item: TurnRailItem) => turnRailPreviewSource(rowsRef.current, item.id),
    [],
  );
  const selectTurnRailItem = useCallback(
    (item: TurnRailItem) => scrollToMessage(item.messageIndex),
    [scrollToMessage],
  );

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (
        e as CustomEvent<{ index: number; tabId?: string; highlightRowIds?: string[] }>
      ).detail;
      // A jump addressed to another chat is not ours (an unaddressed one, from
      // an older sender, still is).
      if (detail?.tabId && detail.tabId !== tabId) return;
      if (typeof detail?.index !== "number") return;
      const ids = detail.highlightRowIds;
      if (ids?.length) {
        // The first id is the row itself; a `wk:` one names its turn's fold.
        pendingRevealRef.current = {
          index: detail.index,
          target: ids[0],
          workFoldId: ids.find((id) => id.startsWith("wk:")),
          highlight: ids,
          steps: 0,
        };
        continueReveal();
        return;
      }
      pendingRevealRef.current = null;
      pendingHighlightRef.current = null;
      scrollToMessage(detail.index);
    };
    window.addEventListener("atlas:chat-jump", handler);
    return () => window.removeEventListener("atlas:chat-jump", handler);
  }, [scrollToMessage, continueReveal, tabId]);

  return {
    scrollToBottom,
    scrollToMessage,
    turnRailItems,
    getTurnRailPreview,
    selectTurnRailItem,
  };
}
