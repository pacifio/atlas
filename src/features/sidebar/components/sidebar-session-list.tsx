// The sidebar's sessions: the header (search, project filter), then one
// scroller holding the pinned block, the active list,
// the Snoozed shelf and the Settled shelf.
//
// This is the container: it reads the stores, owns the scroller and its
// virtual window, and hands rows and sections their props. The drag is
// `use-pinned-drag.ts`, the header search `use-session-search.ts`, the
// shelves' rows `use-session-shelves.ts`; the sections below the active list
// render from `views/session-list-sections.tsx`.
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
// Keyboard: ↑/↓ move between rows (focus follows, the virtualizer scrolls
// the next one in), Home/End jump to the ends, Enter or Space opens. In the
// search field, ↑/↓ move the result highlight and Enter opens it.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { cn } from "@/lib/utils";
import { registerSettleAndAdvance } from "@/features/chat/lib/settle-and-advance";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { ImportThreadsModal } from "@/features/chat/components/import-threads-modal";
import { pickAndAddProject } from "@/features/projects/lib/pick-project";
import { noteSessionListScroll } from "../lib/session-list-scroll";
import { SETTLED_SHELF_PAGE, type SidebarSession } from "../lib/sidebar-sessions";
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
import { dropVerbFor, pinnedOffsets, usePinnedDrag } from "../hooks/use-pinned-drag";
import { useSessionSearch } from "../hooks/use-session-search";
import { useSessionShelves } from "../hooks/use-session-shelves";
import { useSidebarStore } from "../stores/sidebar-store";
import { CARD_ROW_HEIGHT, SessionRow, type SessionRowHandlers } from "./session-row";
import { SessionSearchResultRow } from "./session-search-result-row";
import { SessionRowMenu, type SessionMenuActions } from "./session-row-menu";
import { SidebarSectionLabel } from "./sidebar-section-header";
import { SidebarSessionHeader, searchResultId } from "./sidebar-session-header";
import { CustomSnoozeDialogHost } from "./custom-snooze-dialog";
import {
  SessionListEmptyView,
  SessionListErrorView,
  SessionSearchResultsView,
  SettledShelfView,
  SnoozedShelfView,
} from "./views/session-list-sections";

export function SidebarSessions() {
  const { partition, projects, scopeProjectId, isLoading, error } = useSidebarSessions();
  const { pinned, active, snoozed, settled } = partition;
  const live = useLiveSessions();
  const activeSessionId = useActiveSessionId();
  const settleShortcut = useActionShortcut("chat.settleSession")?.label ?? null;
  const renamingThreadId = useSidebarStore.use.renamingThreadId();
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

  const { drag, beginDrag, pinnedBlockRef, suppressClickRef } = usePinnedDrag(listRef);
  const menuPendingRef = useRef<SidebarSession | null>(null);
  const search = useSessionSearch({ pinned, active, snoozed, settled });
  const { isSearching, results, activeResultIndex } = search;
  const shelves = useSessionShelves({ snoozed, settled, activeSessionId, live, scopeProjectId });
  const { snoozedRows, shelfRows } = shelves;

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
  }, [isSearching, pinned.length, pinnedBlockRef]);

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
  // A shelf's row: slim, never dragged.
  const renderShelfRow = (session: SidebarSession) => (
    <SessionRow
      key={session.threadId}
      {...rowProps(session)}
      variant="slim"
      isPinned={false}
      dragOffset={0}
      isDragging={false}
      dropVerb={null}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SidebarSessionHeader
        searchInputRef={search.searchInputRef}
        searchQuery={search.search}
        onSearchQueryChange={search.setQuery}
        onSearchKeyDown={search.onSearchKeyDown}
        isSearching={isSearching}
        searchResultCount={results.length}
        activeSearchResultIndex={activeResultIndex}
        onClearSearch={() => search.setQuery("")}
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
                <SessionSearchResultsView
                  query={search.search}
                  results={results}
                  renderResult={(session, index) => (
                    <SessionSearchResultRow
                      key={session.threadId}
                      session={session}
                      resultId={searchResultId(index)}
                      isHighlighted={index === activeResultIndex}
                      isActive={session.sessionId !== "" && session.sessionId === activeSessionId}
                      onHighlight={search.highlight}
                      onSelect={(row) => openSession(row)}
                      onMenuTarget={handlers.menuTarget}
                    />
                  )}
                />
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
                    <SnoozedShelfView
                      count={snoozed.length}
                      expanded={shelves.snoozedExpanded}
                      onToggle={() => sidebarActions.setSnoozedExpanded(!shelves.snoozedExpanded)}
                      rows={snoozedRows}
                      renderRow={renderShelfRow}
                    />
                  ) : null}
                  {settled.length > 0 ? (
                    <SettledShelfView
                      count={settled.length}
                      expanded={shelves.settledExpanded}
                      onToggle={() => sidebarActions.setSettledExpanded(!shelves.settledExpanded)}
                      search={shelves.settledSearch}
                      onSearchChange={sidebarActions.setSettledSearch}
                      rows={shelfRows}
                      renderRow={renderShelfRow}
                      noMatches={shelves.settledNoMatches}
                      hiddenCount={shelves.hiddenSettledCount}
                      pageSize={SETTLED_SHELF_PAGE}
                      onShowMore={shelves.showMoreSettled}
                    />
                  ) : null}
                  {drag?.active && drag.from === "pinned" && drag.pinnedIndex === null ? (
                    <SidebarSectionLabel tone="accent">Drop to unpin</SidebarSectionLabel>
                  ) : null}
                  {error &&
                  pinned.length + active.length + snoozed.length + settled.length === 0 ? (
                    <SessionListErrorView error={error} />
                  ) : isEmpty ? (
                    <SessionListEmptyView
                      hasProjects={projects.length > 0}
                      scopedProjectName={scopedProject?.name ?? null}
                      onAddProject={() => void pickAndAddProject()}
                      onImportSessions={() => setImportOpen(true)}
                    />
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
