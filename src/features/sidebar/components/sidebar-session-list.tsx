// The sidebar's sessions: the header (search, new session), then one
// scroller holding the pinned block, the active list,
// the Snoozed shelf and the Settled shelf.
//
// Built for a thousand sessions and more:
//  - The active list is virtualized; only the rows on screen (plus overscan)
//    are mounted. The pinned block and the shelves' open pages are short by
//    construction and render plainly above and below it, in the same scroller.
//  - Every row is memoised on primitive props and one stable handler bag.
//    The handlers read the list at call time through a ref, so nothing the
//    rows are given changes when the list does.
//  - The live state comes through one narrow chat-store signature
//    (`useLiveSessions`): a streaming chunk re-renders nothing here; a status
//    change re-renders the rows whose `live` changed.
//
// Pinned rows reorder by drag (hand-rolled on pointer events): a press that
// travels 4px becomes a drag; the rows between make room; the drop writes one
// fractional key (`pin-order.ts`). Dragging an active row onto the pinned
// block pins it there; dragging a pinned row out unpins it.
//
// Keyboard: ↑/↓ move between rows (focus follows, the virtualizer scrolls
// the next one in), Home/End jump to the ends, Enter or Space opens. In the
// search field, ↑/↓ move the result highlight and Enter opens it.

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Plus, Search, X } from "lucide-react";
import { toast } from "sonner";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { cn } from "@/lib/utils";
import { openNewAgentChat } from "@/features/chat/lib/open-agent-session";
import { registerSettleAndAdvance } from "@/features/chat/lib/settle-and-advance";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { useAppStore } from "@/features/app/stores/app-store";
import { ImportThreadsModal } from "@/features/chat/components/import-threads-modal";
import { pickAndAddProject } from "@/features/projects/lib/pick-project";
import { noteSessionListScroll } from "../lib/session-list-scroll";
import {
  SETTLED_SHELF_FIRST_PAGE,
  SETTLED_SHELF_PAGE,
  searchSidebarSessions,
  type SidebarSession,
} from "../lib/sidebar-sessions";
import {
  copyToClipboard,
  deleteSession,
  markRead,
  markUnread,
  newSessionOnBranch,
  openProjectSettings,
  openSession,
  pinSession,
  renameSession,
  reorderPinned,
  settleSession,
  snoozeSession,
  unpinSession,
  unsettleSession,
  wakeSession,
  type SidebarListSnapshot,
} from "../lib/sidebar-actions";
import {
  useActiveSessionId,
  useLiveSessions,
  useSidebarSessions,
} from "../hooks/use-sidebar-sessions";
import { useSidebarStore } from "../stores/sidebar-store";
import {
  CARD_ROW_HEIGHT,
  SessionRow,
  SessionSearchResultRow,
  type SessionDropVerb,
  type SessionRowHandlers,
} from "./session-row";
import { SessionRowMenu, type SessionMenuActions } from "./session-row-menu";
import { CollapsibleSectionHeader, SidebarSectionLabel } from "./sidebar-section-header";
import { SEARCH_RESULTS_ID, SidebarSessionHeader, searchResultId } from "./sidebar-session-header";
import { CustomSnoozeDialogHost } from "./custom-snooze-dialog";

/** How far a press must travel before it is a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

interface DragState {
  threadId: string;
  from: "pinned" | "active";
  startY: number;
  dy: number;
  /** Past the threshold: the row follows the pointer. */
  active: boolean;
  /** Where in the pinned block a drop would land, or `null` outside it. */
  pinnedIndex: number | null;
}

/** Each pinned row's offset while a pinned row is dragged within the block:
 *  the dragged one follows the pointer, the ones it passes make room. */
function pinnedOffsets(
  drag: DragState | null,
  pinned: readonly SidebarSession[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!drag?.active) return out;
  const from = pinned.findIndex((row) => row.threadId === drag.threadId);
  if (drag.from === "pinned") out.set(drag.threadId, drag.dy);
  if (drag.from !== "pinned" || from === -1 || drag.pinnedIndex === null) return out;
  const to = drag.pinnedIndex;
  pinned.forEach((row, i) => {
    if (i === from) return;
    if (from < to && i > from && i <= to) out.set(row.threadId, -CARD_ROW_HEIGHT);
    else if (from > to && i >= to && i < from) out.set(row.threadId, CARD_ROW_HEIGHT);
  });
  return out;
}

function dropVerbFor(drag: DragState | null): SessionDropVerb | null {
  if (!drag?.active) return null;
  if (drag.from === "pinned") return drag.pinnedIndex === null ? "unpin" : null;
  return drag.pinnedIndex === null ? null : "pin";
}

export function SidebarSessions() {
  const { partition, projects, scopeProjectId, isLoading, error } = useSidebarSessions();
  const { pinned, active, snoozed, settled } = partition;
  const live = useLiveSessions();
  const activeSessionId = useActiveSessionId();
  const hasProject = useAppStore((s) => !!s.currentProject);
  const settleShortcut = useActionShortcut("chat.settleSession")?.label ?? null;
  const newSessionShortcut = useActionShortcut("tabs.newChat")?.label ?? null;
  const renamingThreadId = useSidebarStore.use.renamingThreadId();
  const search = useSidebarStore.use.search();
  const snoozedExpanded = useSidebarStore.use.snoozedExpanded();
  const settledExpanded = useSidebarStore.use.settledExpanded();
  const settledSearch = useSidebarStore.use.settledSearch();
  const searchFocusRequest = useSidebarStore.use.searchFocusRequest();
  // The empty list's "Import sessions" (the picker opens its own).
  const [importOpen, setImportOpen] = useState(false);
  const sidebarActions = useSidebarStore.use.actions();

  // ── What the handlers read at call time ─────────────────────────────────
  const listRef = useRef<SidebarListSnapshot>({
    pinned,
    active,
    snoozed,
    settled,
    activeSessionId,
  });
  useLayoutEffect(() => {
    listRef.current = { pinned, active, snoozed, settled, activeSessionId };
  }, [pinned, active, snoozed, settled, activeSessionId]);
  const scopeRef = useRef(scopeProjectId);
  useLayoutEffect(() => {
    scopeRef.current = scopeProjectId;
  }, [scopeProjectId]);

  // ── Drag ────────────────────────────────────────────────────────────────
  const [drag, setDrag] = useState<DragState | null>(null);
  const pinnedBlockRef = useRef<HTMLUListElement>(null);
  const suppressClickRef = useRef(false);
  const menuPendingRef = useRef<SidebarSession | null>(null);

  // ── Search ──────────────────────────────────────────────────────────────
  const searchInputRef = useRef<HTMLInputElement>(null);
  const deferredSearch = useDeferredValue(search);
  const isSearching = search.trim().length > 0;
  const results = useMemo(
    () =>
      isSearching
        ? searchSidebarSessions([...pinned, ...active, ...snoozed, ...settled], deferredSearch)
        : [],
    [isSearching, pinned, active, snoozed, settled, deferredSearch],
  );
  const [activeResultIndex, setActiveResultIndex] = useState(0);
  const resultsRef = useRef(results);
  useLayoutEffect(() => {
    resultsRef.current = results;
  }, [results]);
  useEffect(() => {
    if (searchFocusRequest === 0) return;
    const input = searchInputRef.current;
    input?.focus();
    input?.select();
  }, [searchFocusRequest]);

  // ── The Snoozed shelf ───────────────────────────────────────────────────
  // Shut by default. Shut, it still shows the open session, so the row the
  // window is looking at never vanishes into a closed shelf.
  const snoozedRows = useMemo(
    () =>
      snoozedExpanded
        ? snoozed
        : snoozed.filter((row) => row.sessionId !== "" && row.sessionId === activeSessionId),
    [snoozed, snoozedExpanded, activeSessionId],
  );

  // ── The Settled shelf ───────────────────────────────────────────────────
  const [settledLimit, setSettledLimit] = useState(SETTLED_SHELF_FIRST_PAGE);
  const [shelfScope, setShelfScope] = useState(scopeProjectId);
  if (shelfScope !== scopeProjectId) {
    setShelfScope(scopeProjectId);
    setSettledLimit(SETTLED_SHELF_FIRST_PAGE);
  }
  const deferredSettledSearch = useDeferredValue(settledSearch);
  const settledFiltered = useMemo(
    () =>
      deferredSettledSearch.trim()
        ? searchSidebarSessions(settled, deferredSettledSearch)
        : settled,
    [settled, deferredSettledSearch],
  );
  // Collapsed, the shelf still shows what must be seen: the open session,
  // and any that came alive again. Outside activity does not un-settle a
  // session, but it must not be buried behind a shut shelf either.
  const shelfRows = useMemo(() => {
    if (deferredSettledSearch.trim()) return settledFiltered;
    if (settledExpanded) return settledFiltered.slice(0, settledLimit);
    return settledFiltered.filter(
      (row) =>
        (row.sessionId !== "" && row.sessionId === activeSessionId) ||
        row.liveElsewhere ||
        row.heldWorking ||
        live.has(row.sessionId),
    );
  }, [
    deferredSettledSearch,
    settledFiltered,
    settledExpanded,
    settledLimit,
    activeSessionId,
    live,
  ]);
  const hiddenSettledCount =
    settledExpanded && !deferredSettledSearch.trim()
      ? settledFiltered.length - shelfRows.length
      : 0;

  // ── Handlers: one stable bag for every row ──────────────────────────────
  const [handlers] = useState<SessionRowHandlers>(() => ({
    open: (session) => {
      if (suppressClickRef.current) return;
      openSession(session);
    },
    menuTarget: (session) => {
      menuPendingRef.current = session;
    },
    settle: (session) => void settleSession(session, listRef.current),
    unsettle: (session) => unsettleSession(session),
    snooze: (session, until) => void snoozeSession(session, until, listRef.current),
    unpin: (session) => void unpinSession(session),
    wake: (session) => wakeSession(session),
    acknowledgeWoke: (session) => markRead(session),
    startRename: (session) => useSidebarStore.getState().actions.beginRename(session.threadId),
    commitRename: (session, title) => {
      useSidebarStore.getState().actions.endRename();
      void renameSession(session, title);
    },
    cancelRename: () => useSidebarStore.getState().actions.endRename(),
    dragStart: (session, event) => beginDrag(session, event),
  }));

  const menuActions = useMemo<SessionMenuActions>(
    () => ({
      pin: (session) => pinSession(session, listRef.current),
      unpin: (session) => void unpinSession(session),
      newSessionOnBranch: (session) => void newSessionOnBranch(session),
      markUnread,
      markRead,
      snooze: (session, until) => void snoozeSession(session, until, listRef.current),
      wake: wakeSession,
      settle: (session) => void settleSession(session, listRef.current),
      unsettle: unsettleSession,
      // On the next frame: the menu is still handing focus back, and a field
      // that mounts during that would lose it.
      rename: (session) =>
        requestAnimationFrame(() =>
          useSidebarStore.getState().actions.beginRename(session.threadId),
        ),
      toggleProjectFilter: (session) =>
        useSidebarStore.getState().actions.toggleScopeProjectId(session.projectId),
      copy: (value, what) => void copyToClipboard(value, what),
      projectSettings: (session) => openProjectSettings(session.projectPath),
      delete: (session) => void deleteSession(session),
    }),
    [],
  );

  // The drag controller. Window listeners for the life of one press, so a
  // pointer that leaves the row (or the sidebar) still ends the drag.
  const beginDrag = (session: SidebarSession, event: ReactPointerEvent<HTMLElement>) => {
    if (useSidebarStore.getState().search.trim()) return;
    const from = session.pinnedAt !== null ? "pinned" : "active";
    const startY = event.clientY;
    let state: DragState = {
      threadId: session.threadId,
      from,
      startY,
      dy: 0,
      active: false,
      pinnedIndex: null,
    };
    const indexAt = (clientY: number): number | null => {
      const block = pinnedBlockRef.current;
      const count = listRef.current.pinned.length;
      if (!block) return null;
      const rect = block.getBoundingClientRect();
      const slack = CARD_ROW_HEIGHT / 2;
      if (clientY < rect.top - slack || clientY > rect.bottom + slack) return null;
      const max = from === "pinned" ? Math.max(0, count - 1) : count;
      const raw =
        from === "pinned"
          ? Math.floor((clientY - rect.top) / CARD_ROW_HEIGHT)
          : Math.round((clientY - rect.top) / CARD_ROW_HEIGHT);
      return Math.min(Math.max(raw, 0), max);
    };
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (!state.active && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      state = { ...state, dy, active: true, pinnedIndex: indexAt(ev.clientY) };
      setDrag(state);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      setDrag(null);
      if (!state.active) return;
      // The click that follows a drag's pointerup is not an open.
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (commit) commitDrop(session, state);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  };

  const commitDrop = (session: SidebarSession, state: DragState) => {
    const list = listRef.current;
    const ids = list.pinned.map((row) => row.threadId);
    if (state.from === "pinned") {
      if (state.pinnedIndex === null) {
        void unpinSession(session);
        return;
      }
      const from = ids.indexOf(session.threadId);
      if (from === -1 || from === state.pinnedIndex) return;
      ids.splice(from, 1);
      ids.splice(state.pinnedIndex, 0, session.threadId);
      void reorderPinned(session.threadId, ids, list);
      return;
    }
    if (state.pinnedIndex === null) return;
    ids.splice(state.pinnedIndex, 0, session.threadId);
    void reorderPinned(session.threadId, ids, list);
  };

  // ── The settle chord: the open session of the chat tab in front ─────────
  useEffect(
    () =>
      registerSettleAndAdvance((tabId) => {
        const sessionId = useChatStore.getState().sessions[tabId]?.acpSessionId ?? null;
        const list = listRef.current;
        const session = sessionId
          ? [...list.pinned, ...list.active, ...list.snoozed, ...list.settled].find(
              (row) => row.sessionId === sessionId,
            )
          : undefined;
        if (!session) {
          toast.info("Nothing to settle: this session has no messages yet.");
          return;
        }
        if (session.settledAt !== null) unsettleSession(session);
        else void settleSession(session, list);
      }),
    [],
  );

  // ── The scroller and its virtual window ─────────────────────────────────
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeListRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  // The active rows do not start at the scroller's top — the pinned block
  // sits above them in the same scroll element. Measured off the two rects
  // rather than `offsetTop`, which answers relative to the nearest
  // positioned ancestor.
  useLayoutEffect(() => {
    const list = activeListRef.current;
    const scroller = scrollerRef.current;
    if (!list || !scroller) return;
    const measure = () =>
      setScrollMargin(
        list.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      );
    measure();
    const ro = new ResizeObserver(measure);
    if (pinnedBlockRef.current) ro.observe(pinnedBlockRef.current);
    ro.observe(scroller);
    return () => ro.disconnect();
  }, [isSearching, pinned.length]);

  const virtualizer = useVirtualizer({
    count: isSearching ? 0 : active.length,
    scrollMargin,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => CARD_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (i) => active[i]?.threadId ?? i,
  });

  // ── Keyboard ────────────────────────────────────────────────────────────
  const orderRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    orderRef.current = [...pinned, ...active, ...snoozedRows, ...shelfRows].map(
      (row) => row.threadId,
    );
  }, [pinned, active, snoozedRows, shelfRows]);

  const focusRow = useCallback(
    (index: number) => {
      const order = orderRef.current;
      const threadId = order[index];
      if (!threadId) return;
      const { pinned: p, active: a } = listRef.current;
      const activeIndex = index - p.length;
      if (activeIndex >= 0 && activeIndex < a.length) {
        virtualizer.scrollToIndex(activeIndex, { align: "auto" });
      }
      const find = () =>
        scrollerRef.current?.querySelector<HTMLElement>(
          `[data-session-row="${CSS.escape(threadId)}"] [role="button"]`,
        );
      const el = find();
      if (el) {
        el.focus();
        el.scrollIntoView({ block: "nearest" });
        return;
      }
      requestAnimationFrame(() => find()?.focus());
    },
    [virtualizer],
  );

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.getAttribute("role") !== "button") return;
    const row = target.closest<HTMLElement>("[data-session-row]");
    if (!row) return;
    const order = orderRef.current;
    const index = order.indexOf(row.dataset.sessionRow ?? "");
    if (index === -1) return;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(index + 1, order.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = order.length - 1;
    if (next === null) return;
    event.preventDefault();
    if (next !== index) focusRow(next);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const count = resultsRef.current.length;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (count === 0) return;
      setActiveResultIndex((i) => Math.min(i + 1, count - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResultIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      const session = resultsRef.current[activeResultIndex];
      if (!session) return;
      event.preventDefault();
      openSession(session);
    } else if (event.key === "Escape") {
      if (!useSidebarStore.getState().search) return;
      event.preventDefault();
      event.stopPropagation();
      sidebarActions.setSearch("");
    }
  };

  // Keep the highlighted result in view as the arrows move it.
  useEffect(() => {
    if (!isSearching) return;
    document
      .getElementById(searchResultId(activeResultIndex))
      ?.scrollIntoView({ block: "nearest" });
  }, [activeResultIndex, isSearching]);

  const offsets = pinnedOffsets(drag, pinned);
  const dropVerb = dropVerbFor(drag);
  const showPinDropZone = drag?.active && drag.from === "active";
  const isEmpty =
    !isLoading && pinned.length + active.length + snoozed.length + settled.length === 0;
  const scopedProject = projects.find((project) => project.id === scopeProjectId) ?? null;

  const rowProps = (session: SidebarSession) => {
    const liveSession = live.get(session.sessionId);
    return {
      session,
      live: liveSession?.status ?? null,
      liveTabId: liveSession?.tabId ?? null,
      isActive: session.sessionId !== "" && session.sessionId === activeSessionId,
      isRenaming: renamingThreadId === session.threadId,
      settleShortcut,
      handlers,
    };
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarSessionHeader
        searchInputRef={searchInputRef}
        searchQuery={search}
        onSearchQueryChange={(value) => {
          sidebarActions.setSearch(value);
          setActiveResultIndex(0);
        }}
        onSearchKeyDown={onSearchKeyDown}
        isSearching={isSearching}
        searchResultCount={results.length}
        activeSearchResultIndex={activeResultIndex}
        onClearSearch={() => {
          sidebarActions.setSearch("");
          setActiveResultIndex(0);
        }}
        onNewSession={() => openNewAgentChat()}
        newSessionDisabled={!hasProject}
        newSessionShortcut={newSessionShortcut}
      />
      <SessionRowMenu
        scopedToProject={scopeProjectId !== null}
        settleShortcut={settleShortcut}
        actions={menuActions}
        pendingRef={menuPendingRef}
      >
        <TooltipPrimitive.Provider delay={150} closeDelay={0} timeout={400}>
          {/* The list's top edge, under the search row: a short fade from the
              sidebar's colour, so rows scroll out under the header rather
              than being cut by it — the footer dock's fade, mirrored. Over the
              scroller, not in it, so it stays put while the rows move. Flush
              against the search row: the room between them is the scroller's
              top padding, not a gap in the column, so rows scroll right up to
              the header instead of vanishing a strip short of it. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-panel h-4 bg-gradient-to-b from-sidebar to-transparent"
            />
            <div
              ref={scrollerRef}
              onKeyDown={onListKeyDown}
              onScroll={noteSessionListScroll}
              className="hide-scrollbar relative min-h-0 flex-1 overflow-y-auto px-2 pt-1.5 pb-2"
            >
              {isSearching ? (
                results.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    No sessions match “{search.trim()}”.
                  </div>
                ) : (
                  <ul
                    id={SEARCH_RESULTS_ID}
                    role="listbox"
                    aria-label="Search results"
                    className="flex flex-col"
                  >
                    {results.map((session, index) => (
                      <SessionSearchResultRow
                        key={session.threadId}
                        session={session}
                        resultId={searchResultId(index)}
                        isHighlighted={index === activeResultIndex}
                        isActive={session.sessionId !== "" && session.sessionId === activeSessionId}
                        onHighlight={(threadId) => {
                          const i = resultsRef.current.findIndex(
                            (row) => row.threadId === threadId,
                          );
                          if (i !== -1) setActiveResultIndex(i);
                        }}
                        onSelect={(row) => openSession(row)}
                        onMenuTarget={handlers.menuTarget}
                      />
                    ))}
                  </ul>
                )
              ) : (
                <>
                  <ul
                    ref={pinnedBlockRef}
                    aria-label="Pinned sessions"
                    className={cn(
                      "flex flex-col",
                      showPinDropZone && pinned.length === 0 && "min-h-9",
                    )}
                  >
                    {showPinDropZone && pinned.length === 0 ? (
                      <li
                        className={cn(
                          "flex h-9 list-none items-center justify-center rounded-md border border-dashed text-xs",
                          drag?.pinnedIndex !== null
                            ? "border-primary/40 bg-primary/5 text-primary"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        Drop to pin
                      </li>
                    ) : null}
                    {pinned.map((session) => (
                      <SessionRow
                        key={session.threadId}
                        {...rowProps(session)}
                        variant="card"
                        isPinned
                        dragOffset={offsets.get(session.threadId) ?? 0}
                        isDragging={drag?.active === true && drag.threadId === session.threadId}
                        dropVerb={
                          drag?.active && drag.threadId === session.threadId ? dropVerb : null
                        }
                      />
                    ))}
                  </ul>
                  {pinned.length > 0 && active.length > 0 ? (
                    <div aria-hidden className="mx-2 my-1 h-px bg-border-subtle" />
                  ) : null}
                  <div
                    ref={activeListRef}
                    role="list"
                    aria-label="Active sessions"
                    style={{
                      // Already net of scrollMargin (the virtualizer subtracts it).
                      height: virtualizer.getTotalSize(),
                      position: "relative",
                    }}
                  >
                    {virtualizer.getVirtualItems().map((item) => {
                      const session = active[item.index];
                      if (!session) return null;
                      const dragging = drag?.active === true && drag.threadId === session.threadId;
                      return (
                        <ul
                          key={session.threadId}
                          className="absolute top-0 left-0 w-full"
                          style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
                        >
                          <SessionRow
                            {...rowProps(session)}
                            variant="card"
                            isPinned={false}
                            dragOffset={dragging ? drag.dy : 0}
                            isDragging={dragging}
                            dropVerb={dragging ? dropVerb : null}
                          />
                        </ul>
                      );
                    })}
                  </div>
                  {snoozed.length > 0 ? (
                    <div className="mt-2">
                      <CollapsibleSectionHeader
                        expanded={snoozedExpanded}
                        tone="info"
                        onClick={() => sidebarActions.setSnoozedExpanded(!snoozedExpanded)}
                        data-testid="sidebar-snoozed-shelf-toggle"
                      >
                        {snoozedExpanded ? "Snoozed" : `Snoozed (${snoozed.length})`}
                      </CollapsibleSectionHeader>
                      <ul aria-label="Snoozed sessions" className="flex flex-col">
                        {snoozedRows.map((session) => (
                          <SessionRow
                            key={session.threadId}
                            {...rowProps(session)}
                            variant="slim"
                            isPinned={false}
                            dragOffset={0}
                            isDragging={false}
                            dropVerb={null}
                          />
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {settled.length > 0 ? (
                    <div className="mt-2">
                      <CollapsibleSectionHeader
                        expanded={settledExpanded}
                        onClick={() => sidebarActions.setSettledExpanded(!settledExpanded)}
                        data-testid="sidebar-settled-shelf-toggle"
                      >
                        {settledExpanded ? "Settled" : `Settled (${settled.length})`}
                      </CollapsibleSectionHeader>
                      {settledExpanded ? (
                        <label className="mx-0.5 mb-1 flex h-7 cursor-text items-center gap-2 rounded-md px-2 text-muted-foreground hover:bg-element-hover focus-within:bg-element-hover">
                          <Search aria-hidden className="size-3 shrink-0" />
                          <input
                            type="search"
                            value={settledSearch}
                            onChange={(event) =>
                              sidebarActions.setSettledSearch(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape" && settledSearch) {
                                event.preventDefault();
                                event.stopPropagation();
                                sidebarActions.setSettledSearch("");
                              }
                            }}
                            placeholder="Search settled"
                            aria-label="Search settled sessions"
                            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
                          />
                          {settledSearch ? (
                            <button
                              type="button"
                              aria-label="Clear settled search"
                              onClick={() => sidebarActions.setSettledSearch("")}
                              className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:text-foreground"
                            >
                              <X aria-hidden className="size-3" />
                            </button>
                          ) : null}
                        </label>
                      ) : null}
                      <ul aria-label="Settled sessions" className="flex flex-col">
                        {shelfRows.map((session) => (
                          <SessionRow
                            key={session.threadId}
                            {...rowProps(session)}
                            variant="slim"
                            isPinned={false}
                            dragOffset={0}
                            isDragging={false}
                            dropVerb={null}
                          />
                        ))}
                        {settledExpanded &&
                        deferredSettledSearch.trim() &&
                        shelfRows.length === 0 ? (
                          <li className="list-none px-2.5 py-2 text-xs text-muted-foreground">
                            No settled sessions match.
                          </li>
                        ) : null}
                        {hiddenSettledCount > 0 ? (
                          <li className="list-none">
                            <button
                              type="button"
                              onClick={() => setSettledLimit((n) => n + SETTLED_SHELF_PAGE)}
                              className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-muted-foreground hover:bg-element-hover hover:text-foreground"
                            >
                              <Plus aria-hidden className="size-4 shrink-0" />
                              Show {Math.min(hiddenSettledCount, SETTLED_SHELF_PAGE)} more
                            </button>
                          </li>
                        ) : null}
                      </ul>
                    </div>
                  ) : null}
                  {drag?.active && drag.from === "pinned" && drag.pinnedIndex === null ? (
                    <SidebarSectionLabel tone="accent">Drop to unpin</SidebarSectionLabel>
                  ) : null}
                  {error &&
                  pinned.length + active.length + snoozed.length + settled.length === 0 ? (
                    <div className="px-2 py-6 text-center text-xs text-error">
                      Couldn't read session history: {error}
                    </div>
                  ) : isEmpty ? (
                    <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground">
                      {projects.length === 0 ? (
                        <>
                          <span>No projects yet</span>
                          <button
                            type="button"
                            onClick={() => void pickAndAddProject()}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-2xs font-medium text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
                          >
                            <Plus aria-hidden className="-mx-0.5 size-3" />
                            Add project
                          </button>
                        </>
                      ) : scopedProject ? (
                        `No sessions in ${scopedProject.name} yet`
                      ) : (
                        <>
                          <span>No sessions yet</span>
                          <button
                            type="button"
                            onClick={() => setImportOpen(true)}
                            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-2xs font-medium text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
                          >
                            Import sessions from agents…
                          </button>
                        </>
                      )}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </TooltipPrimitive.Provider>
      </SessionRowMenu>
      <CustomSnoozeDialogHost />
      <ImportThreadsModal open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
