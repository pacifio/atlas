// One session in the sidebar's list: the container. It resolves the row's
// status, holds its local UI state (the snooze menu, the pull request badge's
// hover list), wires the list's handlers to the row, and hands one of two
// views plain props: a card for the pinned and active sessions
// (`views/session-row-card-view.tsx`), a slim row for the shelves
// (`views/session-row-slim-view.tsx`). Search results have a row of their own
// (`session-search-result-row.tsx`).
//
// The rest of the row's actions are on right-click (or the context-menu key),
// so the hover row stays two controls.
//
// Rows are memoised on their props, and every prop is either a primitive or
// the list's one stable handler bag, so a delta that touches one session
// re-renders one row. The clocks tick by themselves (`session-row-parts`), and
// the hover card mounts its reads only while it is open.

import { memo, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { PointerEvent } from "react";
import type { SidebarSession } from "../lib/sidebar-sessions";
import { useSessionListScroll } from "../lib/session-list-scroll";
import {
  resolveSessionRowStatus,
  resolveSessionTopStatus,
  sessionRowLabel,
  shouldRecedeSessionRow,
  type SessionLiveStatus,
  type SessionRowStatus,
} from "../lib/session-row-status";
import { requestCustomSnooze } from "./custom-snooze-dialog";
import { TOP_STATUS, type SessionRowViewProps } from "./views/session-row-controls";
import { SessionRowCardView } from "./views/session-row-card-view";
import { SessionRowSlimView } from "./views/session-row-slim-view";

/** Slot heights the list virtualizes on. A card renders 63px (three lines at
 *  Atlas's type scale) with 2px above and below; a slim or search row is 36px.
 *  The pinned drag maths shares the card slot, so the two stay in step. */
export const CARD_ROW_HEIGHT = 67;
export const SLIM_ROW_HEIGHT = 36;

/** What a drop would do to the row being dragged. */
export type SessionDropVerb = "pin" | "unpin";

/** Everything a row can ask the list to do. One object, stable for the
 *  list's lifetime, so it never breaks a row's memo. */
export interface SessionRowHandlers {
  open: (session: SidebarSession) => void;
  /** Right-click, or the ⋯ button: the shared menu is about to open for it. */
  menuTarget: (session: SidebarSession) => void;
  settle: (session: SidebarSession) => void;
  unsettle: (session: SidebarSession) => void;
  snooze: (session: SidebarSession, until: string) => void;
  unpin: (session: SidebarSession) => void;
  /** End a snooze now. */
  wake: (session: SidebarSession) => void;
  acknowledgeWoke: (session: SidebarSession) => void;
  startRename: (session: SidebarSession) => void;
  commitRename: (session: SidebarSession, title: string) => void;
  cancelRename: () => void;
  /** A press that may become a drag (pinned and active rows). */
  dragStart: (session: SidebarSession, event: PointerEvent<HTMLElement>) => void;
}

export interface SessionRowProps {
  session: SidebarSession;
  variant: "card" | "slim";
  live: SessionLiveStatus;
  /** The tab running the session, when it is open; its turn clock is read. */
  liveTabId: string | null;
  isPinned: boolean;
  isActive: boolean;
  isRenaming: boolean;
  /** Pixels the row is moved by a drag in progress (its own, or a sibling
   *  making room); `0` at rest. */
  dragOffset: number;
  isDragging: boolean;
  dropVerb: SessionDropVerb | null;
  settleShortcut: string | null;
  handlers: SessionRowHandlers;
}

export const SessionRow = memo(function SessionRow(props: SessionRowProps) {
  const { session, variant, handlers, isRenaming } = props;
  const status: SessionRowStatus = resolveSessionRowStatus({
    live: props.live,
    liveElsewhere: session.liveElsewhere,
    heldWorking: session.heldWorking,
    watching: session.pullRequests.some((p) => p.watching),
  });
  const isUnread = session.unread;
  const isWoke = session.woke && session.settledAt === null;
  const topStatus = resolveSessionTopStatus({ status, unread: isUnread, woke: isWoke });
  const shouldRecede = shouldRecedeSessionRow({
    status,
    unread: isUnread,
    woke: isWoke,
    active: props.isActive,
  });
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  // The pull request badge's hover list is showing: the row's own hover card
  // would cover it.
  const [badgeOpen, setBadgeOpen] = useState(false);

  const handleClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return;
    handlers.open(session);
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handlers.open(session);
  };
  const handleDoubleClick = (event: MouseEvent) => {
    if (isRenaming || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    event.preventDefault();
    handlers.startRename(session);
  };
  const handleContextMenu = () => handlers.menuTarget(session);
  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0 || isRenaming) return;
    if ((event.target as HTMLElement).closest("button, a, input")) return;
    handlers.dragStart(session, event);
  };

  const accessibleLabel = sessionRowLabel({
    title: session.title,
    statusLabel: topStatus ? TOP_STATUS[topStatus].label : null,
    projectName: session.projectName,
    attachedNames: session.attachedNames,
  });

  // Closed while the list scrolls: the card is anchored to this row, and a
  // scroll carries the row out from under it (`session-list-scroll.ts`).
  const listScrolling = useSessionListScroll.use.scrolling();
  const hoverCardDisabled =
    snoozeMenuOpen || badgeOpen || props.isDragging || isRenaming || listScrolling;

  const viewProps: SessionRowViewProps = {
    session,
    status,
    topStatus,
    shouldRecede,
    isUnread,
    isWoke,
    isActive: props.isActive,
    isRenaming,
    isDragging: props.isDragging,
    accessibleLabel,
    hoverCardDisabled,
    surface: {
      onClick: handleClick,
      onDoubleClick: handleDoubleClick,
      onKeyDown: handleKeyDown,
      onContextMenu: handleContextMenu,
    },
    onSettle: () => handlers.settle(session),
    onCommitRename: (title) => handlers.commitRename(session, title),
    onCancelRename: handlers.cancelRename,
  };

  if (variant === "slim") {
    return (
      <SessionRowSlimView
        {...viewProps}
        onWake={() => handlers.wake(session)}
        onUnsettle={() => handlers.unsettle(session)}
      />
    );
  }

  return (
    <SessionRowCardView
      {...viewProps}
      isPinned={props.isPinned}
      dragOffset={props.dragOffset}
      dropVerb={props.dropVerb}
      liveTabId={props.liveTabId}
      settleShortcut={props.settleShortcut}
      snoozeMenuOpen={snoozeMenuOpen}
      onSnoozeMenuOpenChange={setSnoozeMenuOpen}
      onBadgeOpenChange={setBadgeOpen}
      onPointerDown={handlePointerDown}
      onSnooze={(until) => handlers.snooze(session, until)}
      onCustomSnooze={() => {
        void requestCustomSnooze().then((until) => {
          if (until) handlers.snooze(session, until);
        });
      }}
      onUnpin={() => handlers.unpin(session)}
      onAcknowledgeWoke={() => handlers.acknowledgeWoke(session)}
    />
  );
});
