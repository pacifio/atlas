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
// has to handle — see the re-anchoring in `use-transcript-window.ts`.
//
// Because rows are real DOM, nothing here predicts heights. The whole
// predicted-height apparatus the virtualized version needed — a height
// function, canvas text measurement, a dev drift assertion — is gone.
//
// This file is the CONTAINER: it reads the stores, projects the rows and owns
// the window (`use-transcript-window.ts`) and the jumps
// (`use-transcript-jumps.ts`). What it renders is props-only, under `./views/`.

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import { isBusyAgentStatus, type ChatMessage } from "@/types/agent";
import {
  agentMeta,
  catalogEntry as agentCatalogEntry,
  switchableAgentOf,
} from "@/features/agents/lib/agent-meta";
import { useIsTabVisible } from "@/features/layout/lib/use-tab-visible";
import { projectRows, RowKind, type Projection, type Row } from "../lib/turn-rows";
import { useThawed } from "../lib/use-thawed";
import { useChatStore } from "../stores/chat-store";
import { sessionCanRetry } from "../lib/retry-gate";
import { latestResponseRowId } from "../lib/message-footer";
import { useRcRemoteDriver } from "../stores/rc-store";
import { pinScope } from "../stores/chat-pins-store";
import { projectPathForTab } from "../lib/tab-project";
import { useTranscriptWindow } from "../hooks/use-transcript-window";
import { useTranscriptJumps } from "../hooks/use-transcript-jumps";
import { RowView } from "./views/transcript-row-view";
import { TranscriptView } from "./views/transcript-view";

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
  /** The turn is still in progress, including while it is paused on the user
   *  (a permission or plan approval). `isStreaming` goes false for that pause;
   *  the work header must not read it as the turn being over and fold it. */
  turnInProgress?: boolean;
  agentType?: string;
  /** Vertical space (px) reserved at the top for a header floating over the
   *  transcript, applied as content padding so the first row clears it while
   *  still scrolling under. `0` (the session view) is no header: just a soft
   *  top edge. */
  topInset?: number;
  onShowJumpChange?: (visible: boolean, newCount?: number) => void;
  /** What the working indicator says while the session is still binding and
   *  the first message is held (see `ChatSession.pendingSend`) — "Starting
   *  Claude Code", which names the one thing actually happening. Absent, the
   *  indicator falls back to `WAITING_LABEL`: a turn that HAS been dispatched
   *  is waiting on the model, which is a different claim again. */
  workingLabel?: string;
  /** Offered under the working indicator once a start has stalled (30 s with
   *  no session): restart the agent's process, or switch this tab to another
   *  agent. Only meaningful with `workingLabel`; absent for a normal turn. */
  onStallRestart?: () => void;
  onStallSwitch?: () => void;
  onStallCopyDiagnostics?: () => void;
  /** Bumped on every restart so the indicator's elapsed clock (and its stall
   *  state) start over with the new attempt. */
  workingEpoch?: number;
  /** Rendered under the last row while no turn is running (the "Memory
   *  updated" card). */
  footer?: React.ReactNode;
}

export const Transcript = forwardRef<TranscriptHandle, TranscriptProps>(function Transcript(
  {
    tabId,
    acpSessionId,
    messages,
    isStreaming,
    turnInProgress = isStreaming,
    agentType,
    topInset = 0,
    onShowJumpChange,
    workingLabel,
    onStallRestart,
    onStallSwitch,
    onStallCopyDiagnostics,
    workingEpoch,
    footer,
  },
  ref,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const cacheKey = `${tabId}:${acpSessionId}`;
  const pinScopeKey = pinScope(tabId, acpSessionId);
  // The project root paths in this session resolve against: the one the
  // session was created with, else its tab's project. A primitive, read once
  // here, so rows render file chips without reading a store themselves.
  const workingDirectory = useChatStore((s) => s.sessions[tabId]?.workingDirectory);
  const fileRoot = workingDirectory || projectPathForTab(tabId) || undefined;
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
  // The seat is read in its own subscription (its store, not the chat store's
  // selector), so the chat selector stays O(1) per streaming write.
  const remoteDriving = useRcRemoteDriver(acpSessionId) !== null;
  const canRetry = useChatStore((s) =>
    sessionCanRetry(s.sessions[tabId], supportsRewind, remoteDriving),
  );
  // Whether a new message could go out now — an interrupted turn's Continue.
  // Same O(1) bargain as `canRetry`. A disconnected session counts: sending
  // is what respawns it. Someone else driving does not: only the driver sends.
  const canContinue = useChatStore((s) => {
    const session = s.sessions[tabId];
    return !!session && !remoteDriving && !isBusyAgentStatus(session.status) && !session.stopping;
  });
  // Whether the session could be forked right now — the header's "Branch from
  // here" gate (agent advertised `fork`, session bound), plus idle: a fork
  // taken mid-turn would copy a half-written response. Same O(1) bargain.
  const supportsFork = agentCatalogEntry(agent)?.supportsFork === true;
  const canBranch = useChatStore((s) => {
    const session = s.sessions[tabId];
    return (
      supportsFork &&
      !!session?.acpAgentId &&
      !!session.acpSessionId &&
      !isBusyAgentStatus(session.status) &&
      !session.stopping
    );
  });

  // Delegated children, keyed by their launching call. A stable reference —
  // immer re-identifies it only when a child changes — so this subscription
  // settles, and it is `undefined` for the overwhelming majority of sessions,
  // where the projection then behaves exactly as it did before.
  const subagents = useChatStore((s) => s.sessions[tabId]?.subagents);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  /** Tool sequences the reader has opened. */
  const [expandedTurns, setExpandedTurns] = useState<ReadonlySet<string>>(() => new Set());
  const toggleTurn = useCallback((groupId: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
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
      {
        expanded,
        expandedTurns,
        streaming: isStreaming,
        turnInProgress,
        subagents,
      },
      prevProjectionRef.current,
    );
    prevProjectionRef.current = next;
    return next;
  }, [messages, expanded, expandedTurns, isStreaming, turnInProgress, live, subagents]);
  const rows: Row[] = projection.rows;

  // ── Is the live turn still silent? ───────────────────────────────────
  // A streaming assistant message only becomes a turn once it emits at least
  // one row, so "the thread does not end in an assistant turn while streaming"
  // is exactly the window between hitting send and the first thing appearing.
  // Derived from the projection rather than tracked separately, so it cannot
  // drift out of step with what is actually on screen.
  const lastTurn = projection.turns[projection.turns.length - 1];
  const working = isStreaming && (!lastTurn || lastTurn.role !== "assistant");

  const {
    setStartIndex,
    safeStart,
    visible,
    more,
    onScroll,
    pendingAnchorRef,
    pendingHighlightRef,
    lastSeenLen,
    setNewCount,
  } = useTranscriptWindow({
    scrollRef,
    contentRef,
    rows,
    live,
    cacheKey,
    topInset,
    working,
    onShowJumpChange,
  });

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
  // Branch belongs to the latest settled response, for the same reason.
  const latestResponseId = useMemo(() => latestResponseRowId(rows), [rows]);

  const { scrollToBottom, scrollToMessage, turnRailItems, getTurnRailPreview, selectTurnRailItem } =
    useTranscriptJumps({
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
    });

  useImperativeHandle(ref, () => ({ scrollToBottom, scrollToMessage }), [
    scrollToBottom,
    scrollToMessage,
  ]);

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
  const canBranchRowId = canBranch ? latestResponseId : undefined;
  const rowViews = useMemo(
    () =>
      visible.map((row, i) => (
        // `group` is the hover scope for the user row's action bar
        // (`user-row-actions.tsx`), which is hidden until the row is hovered.
        // The fling hover-suspension in `use-transcript-scroll.ts` keeps hover
        // styles from firing as rows pass under a resting pointer mid-scroll.
        // `data-footer-below` marks a response whose hover footer is drawn by
        // the turn footer row after it; hovering the response reveals it too
        // (`globals.css`).
        <div
          key={row.id}
          className="atlas-row group group/row"
          data-row-id={row.id}
          data-footer-below={row.kind === RowKind.Prose && row.footerBelow ? "" : undefined}
        >
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
            canRetryRowId={canRetryRowId}
            canBranchRowId={canBranchRowId}
            canContinue={canContinue}
            pinScopeKey={pinScopeKey}
            fileRoot={fileRoot}
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
      canBranchRowId,
      canContinue,
      pinScopeKey,
      fileRoot,
      toggleTurn,
      toggleExpand,
    ],
  );

  return (
    <TranscriptView
      scrollRef={scrollRef}
      contentRef={contentRef}
      onScroll={onScroll}
      tabId={tabId}
      live={live}
      topInset={topInset}
      empty={rows.length === 0 && !isStreaming}
      rowViews={rowViews}
      turnInProgress={turnInProgress}
      footer={footer}
      working={working}
      workingEpoch={workingEpoch}
      workingLabel={workingLabel}
      onStallRestart={onStallRestart}
      onStallSwitch={onStallSwitch}
      onStallCopyDiagnostics={onStallCopyDiagnostics}
      more={more}
      turnRailItems={turnRailItems}
      windowStart={safeStart}
      getTurnRailPreview={getTurnRailPreview}
      onSelectTurnRailItem={selectTurnRailItem}
    />
  );
});
