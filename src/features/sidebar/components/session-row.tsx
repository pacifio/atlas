// One session in the sidebar's list.
//
// Two shapes. A card for the pinned and active sessions: the project on top
// (badge, name, pin) with the status slot at its end, the title under it, and
// the branch, its pull request and the agent on the third line. A slim row
// for the shelves: badge, title, and when it was settled — or, on the
// Snoozed shelf, how long until it wakes. Search results get
// a third, flatter row of their own.
//
// The status slot swaps on hover. At rest it says what the session is doing
// (working, waiting for the user, failed, woke, done) or, for a quiet one, how
// long ago it moved; under the pointer it gives way to the row's controls —
// snooze and Settle. The rest of the row's actions are on right-click (or the
// context-menu key), so the hover row stays two controls. A Woke marker stays
// put: it is a button (it dismisses itself).
//
// Rows are memoised on their props, and every prop is either a primitive or
// the list's one stable handler bag, so a delta that touches one session
// re-renders one row. The clocks tick by themselves (`session-row-parts`), and
// the hover card mounts its reads only while it is open.

import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { CSSProperties, PointerEvent } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  AlarmClock,
  AlarmClockOff,
  Check,
  CircleAlert,
  Clock,
  GitBranch,
  MessageCircleQuestion,
  Pin,
  PinOff,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@/ui/dropdown-menu";
import { snoozePresets } from "@/features/chat/lib/session-snooze";
import type { SidebarSession } from "../lib/sidebar-sessions";
import { useSessionListScroll } from "../lib/session-list-scroll";
import {
  resolveSessionRowStatus,
  resolveSessionTopStatus,
  sessionRowLabel,
  shouldRecedeSessionRow,
  type SessionLiveStatus,
  type SessionRowStatus,
  type SessionTopStatus,
} from "../lib/session-row-status";
import {
  CircleDashedCheck,
  ProjectBadgeStack,
  AttachedMark,
  ProjectBadge,
  RelativeTime,
  SessionAgentIcon,
  SnoozeRemaining,
  WorkingDuration,
  WorkingRing,
} from "./session-row-parts";
import { SessionPullRequestBadge } from "./session-pull-request";
import { SessionHoverCardPopup } from "./session-hover-card";
import { requestCustomSnooze } from "./custom-snooze-dialog";

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

const TOP_STATUS: Record<SessionTopStatus, { label: string; className: string }> = {
  input: { label: "Needs input", className: "text-warning" },
  working: { label: "Working", className: "text-info" },
  failed: { label: "Failed", className: "text-error" },
  woke: { label: "Woke", className: "text-warning" },
  done: { label: "Done", className: "text-success" },
};

function TopStatusIcon({ status }: { status: SessionTopStatus }) {
  if (status === "working") return <WorkingRing />;
  if (status === "input")
    return <MessageCircleQuestion aria-hidden className="size-3.5 shrink-0" />;
  if (status === "failed") return <CircleAlert aria-hidden className="size-3.5 shrink-0" />;
  if (status === "done") return <CircleDashedCheck />;
  return null;
}

function SnoozeMenuButton({
  open,
  onOpenChange,
  onSnooze,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (until: string) => void;
}) {
  const presets = open ? snoozePresets(new Date()) : [];
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <Hint label="Snooze session" side="top">
        <MenuPrimitive.Trigger
          render={
            <button
              type="button"
              aria-label="Snooze session"
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              className="inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
            />
          }
        >
          <Clock aria-hidden className="size-3" />
        </MenuPrimitive.Trigger>
      </Hint>
      <DropdownMenuContent side="bottom" align="end">
        {presets.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            onClick={(event) => {
              event.stopPropagation();
              onSnooze(preset.until);
            }}
          >
            {preset.label}
            <DropdownMenuShortcut>{preset.whenLabel}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={async (event) => {
            event.stopPropagation();
            const until = await requestCustomSnooze();
            if (until) onSnooze(until);
          }}
        >
          Custom…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The title, or its rename field. The field commits on Enter or blur and
 *  gives up on Escape. */
function RowTitle({
  session,
  className,
  isRenaming,
  handlers,
}: {
  session: SidebarSession;
  className: string;
  isRenaming: boolean;
  handlers: SessionRowHandlers;
}) {
  const [draft, setDraft] = useState(session.title);
  const committed = useRef(false);
  useEffect(() => {
    if (!isRenaming) return;
    committed.current = false;
    setDraft(session.title);
  }, [isRenaming, session.title]);
  if (!isRenaming) {
    return (
      <span aria-hidden dir="auto" className={className}>
        {session.title}
      </span>
    );
  }
  return (
    <input
      autoFocus
      value={draft}
      dir="auto"
      aria-label="Session title"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter") {
          event.preventDefault();
          committed.current = true;
          handlers.commitRename(session, draft);
        } else if (event.key === "Escape") {
          event.preventDefault();
          committed.current = true;
          handlers.cancelRename();
        }
      }}
      onBlur={() => {
        if (!committed.current) handlers.commitRename(session, draft);
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-border bg-panel-input px-1 text-sm font-medium text-foreground outline-none focus:border-border-strong"
    />
  );
}

export const SessionRow = memo(function SessionRow(props: SessionRowProps) {
  const { session, variant, handlers, isRenaming } = props;
  const status: SessionRowStatus = resolveSessionRowStatus({
    live: props.live,
    liveElsewhere: session.liveElsewhere,
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
  const isWokeStatus = topStatus === "woke";
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);
  // The pull request badge's hover list is showing: the row's own hover card
  // would cover it.
  const [badgeOpen, setBadgeOpen] = useState(false);
  const settled = session.settledAt !== null;
  const snoozed = session.snoozedUntil !== null;

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
  const stop = (run: () => void) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    run();
  };

  const accessibleLabel = sessionRowLabel({
    title: session.title,
    statusLabel: topStatus ? TOP_STATUS[topStatus].label : null,
    projectName: session.projectName,
    attachedNames: session.attachedNames,
  });

  const rowSurfaceClassName = cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    props.isActive
      ? "bg-element-selected text-foreground"
      : shouldRecede
        ? "text-muted-foreground hover:bg-element-hover hover:text-foreground"
        : "bg-transparent text-foreground hover:bg-element-hover",
    shouldRecede &&
      status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    props.isDragging && "bg-element-selected text-foreground opacity-100 shadow-lg",
  );
  const dragStyle: CSSProperties | undefined =
    props.dragOffset !== 0 || props.isDragging
      ? {
          transform: `translateY(${props.dragOffset}px)`,
          transition: props.isDragging ? undefined : "transform 150ms ease-out",
        }
      : undefined;

  const dragDestination = props.dropVerb ? (
    <span
      role="status"
      className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-2xs font-medium text-primary"
    >
      {props.dropVerb === "pin" ? (
        <Pin aria-hidden className="size-3" />
      ) : (
        <PinOff aria-hidden className="size-3" />
      )}
      {props.dropVerb === "pin" ? "Pin" : "Unpin"}
    </span>
  ) : null;

  const wokeButton = (
    <Hint label="Dismiss Woke notification" side="top">
      <button
        type="button"
        aria-label="Dismiss Woke notification"
        onClick={stop(() => handlers.acknowledgeWoke(session))}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          TOP_STATUS.woke.className,
        )}
      >
        <AlarmClock aria-hidden className="size-3.5 shrink-0" />
        <span role="status">Woke</span>
      </button>
    </Hint>
  );

  const showPin = props.isPinned && !props.isDragging;
  const pinIndicator = showPin ? (
    <Hint label="Unpin session" side="top">
      <button
        type="button"
        aria-label="Unpin session"
        onClick={stop(() => handlers.unpin(session))}
        className="group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Pin
          aria-hidden
          className="size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
        />
        <PinOff
          aria-hidden
          className="hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
        />
      </button>
    </Hint>
  ) : null;

  // Closed while the list scrolls: the card is anchored to this row, and a
  // scroll carries the row out from under it (`session-list-scroll.ts`).
  const listScrolling = useSessionListScroll.use.scrolling();
  const hoverCardDisabled =
    snoozeMenuOpen || badgeOpen || props.isDragging || isRenaming || listScrolling;

  if (variant === "slim") {
    return (
      <li data-session-row={session.threadId} className="list-none">
        <TooltipPrimitive.Root disabled={hoverCardDisabled}>
          <TooltipPrimitive.Trigger
            render={
              <div
                role="button"
                tabIndex={0}
                aria-label={accessibleLabel}
                aria-current={props.isActive || undefined}
                data-testid="sidebar-row-slim"
                className={cn(rowSurfaceClassName, "flex h-9 items-center gap-2.5 px-2.5")}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onKeyDown={handleKeyDown}
                onContextMenu={handleContextMenu}
              />
            }
          >
            {isRenaming ? null : <span className="sr-only">{session.title}</span>}
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 transition-opacity",
                (!props.isActive || settled || snoozed) &&
                  "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
              )}
            >
              <ProjectBadgeStack
                name={session.projectName}
                path={session.projectPath}
                attached={session.attachedProjects}
                attachedNames={session.attachedNames}
              />
            </span>
            <RowTitle
              session={session}
              isRenaming={isRenaming}
              handlers={handlers}
              className={cn(
                "min-w-0 flex-1 truncate text-start text-sm transition-opacity group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground motion-reduce:transition-none",
                shouldRecede ? "font-normal" : "font-medium",
                shouldRecede
                  ? "text-secondary-foreground/70"
                  : props.isActive || isWoke || status === "input"
                    ? "text-foreground"
                    : isUnread
                      ? "text-muted-foreground"
                      : "text-secondary-foreground/70",
              )}
            />
            {session.viaAttached && <AttachedMark />}
            <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end">
              {snoozed ? (
                <span className="inline-flex items-center justify-end gap-1 text-xs tabular-nums text-info transition-opacity group-hover/sidebar-row:opacity-0">
                  <AlarmClock aria-hidden className="size-3 shrink-0" />
                  <SnoozeRemaining until={session.snoozedUntil!} />
                </span>
              ) : (
                <span className="inline-flex justify-end text-xs tabular-nums text-secondary-foreground transition-opacity group-hover/sidebar-row:opacity-0">
                  <RelativeTime iso={settled ? session.settledAt : session.updatedAt} />
                </span>
              )}
              <span className="pointer-events-none absolute inset-y-0 right-0 -mr-1 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100">
                {snoozed ? (
                  <Hint label="Wake session" side="top">
                    <button
                      type="button"
                      aria-label="Wake session"
                      onClick={stop(() => handlers.wake(session))}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <AlarmClockOff aria-hidden className="size-3.5" />
                    </button>
                  </Hint>
                ) : settled ? (
                  <Hint label="Un-settle session" side="top">
                    <button
                      type="button"
                      aria-label="Un-settle session"
                      onClick={stop(() => handlers.unsettle(session))}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Undo2 aria-hidden className="mb-px size-3.5" />
                    </button>
                  </Hint>
                ) : (
                  <Hint label="Settle session" side="top">
                    <button
                      type="button"
                      aria-label="Settle session"
                      onClick={stop(() => handlers.settle(session))}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Check aria-hidden className="size-3" />
                    </button>
                  </Hint>
                )}
              </span>
            </span>
          </TooltipPrimitive.Trigger>
          <SessionHoverCardPopup session={session} status={status} />
        </TooltipPrimitive.Root>
      </li>
    );
  }

  return (
    <li
      data-session-row={session.threadId}
      style={dragStyle}
      className={cn("list-none py-0.5", props.isDragging && "relative z-drag")}
    >
      <TooltipPrimitive.Root disabled={hoverCardDisabled}>
        <TooltipPrimitive.Trigger
          render={
            <div
              role="button"
              tabIndex={0}
              aria-label={accessibleLabel}
              aria-current={props.isActive || undefined}
              data-testid="sidebar-row-card"
              className={rowSurfaceClassName}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onKeyDown={handleKeyDown}
              onContextMenu={handleContextMenu}
              onPointerDown={handlePointerDown}
            />
          }
        >
          {isRenaming ? null : <span className="sr-only">{session.title}</span>}
          <div className="relative h-19.5 px-2.5 py-2">
            <div className="flex h-5 min-w-0 items-center gap-1.5">
              <ProjectBadgeStack
                name={session.projectName}
                path={session.projectPath}
                attached={session.attachedProjects}
                attachedNames={session.attachedNames}
              />
              {/* Left of the status slot, the pin would slide when hover swaps
                  the label for the wider row controls. */}
              {pinIndicator}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs text-secondary-foreground",
                  shouldRecede ? "font-normal" : "font-medium",
                )}
              >
                {session.projectName}
                {session.viaAttached && <AttachedMark />}
              </span>
              {props.isDragging ? (
                dragDestination
              ) : (
                <span
                  className={cn(
                    "relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs",
                    // Keyboard focus on a control in the slot moves the status
                    // aside, as hovering the row does.
                    "[&:has(:focus-visible)>[data-yields-to-focus]]:absolute [&:has(:focus-visible)>[data-yields-to-focus]]:right-0 [&:has(:focus-visible)>[data-yields-to-focus]]:opacity-0",
                  )}
                >
                  <span
                    data-yields-to-focus={isWokeStatus ? undefined : ""}
                    className={cn(
                      isWokeStatus
                        ? "pointer-events-auto"
                        : "pointer-events-none group-hover/sidebar-row:absolute group-hover/sidebar-row:right-0 group-hover/sidebar-row:opacity-0",
                      "flex items-center self-center justify-self-end tabular-nums text-secondary-foreground transition-opacity",
                      snoozeMenuOpen && "pointer-events-none absolute right-0 opacity-0",
                    )}
                  >
                    {topStatus ? (
                      isWokeStatus ? (
                        wokeButton
                      ) : (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 font-medium",
                            TOP_STATUS[topStatus].className,
                          )}
                        >
                          <TopStatusIcon status={topStatus} />
                          {/* The label alone is the live region: a role="status"
                              wrapper around the ticking duration would make
                              screen readers announce every second. */}
                          <span role="status">{TOP_STATUS[topStatus].label}</span>
                          {topStatus === "working" ? (
                            <span aria-hidden>
                              <WorkingDuration tabId={props.liveTabId} />
                            </span>
                          ) : null}
                        </span>
                      )
                    ) : (
                      <RelativeTime iso={session.updatedAt} />
                    )}
                  </span>
                  <span
                    className={cn(
                      // focus-visible, not focus-within: a mouse click leaves
                      // the Settle button focused, and a plain focus-within
                      // would keep the controls pinned over the status label
                      // once the pointer moves away.
                      "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:static group-hover/sidebar-row:opacity-100",
                      snoozeMenuOpen && "pointer-events-auto static opacity-100",
                    )}
                  >
                    <SnoozeMenuButton
                      open={snoozeMenuOpen}
                      onOpenChange={setSnoozeMenuOpen}
                      onSnooze={(until) => handlers.snooze(session, until)}
                    />
                    <Hint
                      label={
                        props.isActive && props.settleShortcut
                          ? `Settle session ${props.settleShortcut}`
                          : "Settle session"
                      }
                      side="top"
                    >
                      <button
                        type="button"
                        aria-label="Settle session"
                        onClick={stop(() => handlers.settle(session))}
                        className="-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Check aria-hidden className="size-3.5" />
                        Settle
                      </button>
                    </Hint>
                  </span>
                </span>
              )}
            </div>
            <div className="mt-1 flex min-w-0">
              <RowTitle
                session={session}
                isRenaming={isRenaming}
                handlers={handlers}
                className={cn(
                  "min-w-0 flex-1 truncate text-start text-sm transition-opacity motion-reduce:transition-none",
                  shouldRecede ? "font-normal" : "font-medium",
                  shouldRecede
                    ? "text-secondary-foreground"
                    : isUnread || isWoke || status === "input"
                      ? "text-foreground"
                      : status === "failed"
                        ? "text-foreground/95"
                        : "text-foreground/90",
                )}
              />
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-secondary-foreground">
              {session.branch ? (
                <>
                  <GitBranch aria-hidden className="size-3 shrink-0 text-muted-foreground/60" />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
                    {session.branch}
                  </span>
                </>
              ) : (
                <span className="flex-1" />
              )}
              <SessionPullRequestBadge session={session} onOpenChange={setBadgeOpen} />
              <span
                aria-hidden
                className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1 opacity-60"
              >
                <SessionAgentIcon agent={session.agent} />
              </span>
            </div>
          </div>
        </TooltipPrimitive.Trigger>
        <SessionHoverCardPopup session={session} status={status} />
      </TooltipPrimitive.Root>
    </li>
  );
});

/** A row in the header search's results: flat, one line, the settled ones
 *  dimmed. Highlighted by the search field's arrow keys, not by focus. */
export const SessionSearchResultRow = memo(function SessionSearchResultRow(props: {
  session: SidebarSession;
  isHighlighted: boolean;
  isActive: boolean;
  resultId: string;
  onHighlight: (threadId: string) => void;
  onSelect: (session: SidebarSession) => void;
  onMenuTarget: (session: SidebarSession) => void;
}) {
  const { session } = props;
  const isSettled = session.settledAt !== null;
  const status = resolveSessionRowStatus({
    live: null,
    liveElsewhere: session.liveElsewhere,
    watching: session.pullRequests.some((p) => p.watching),
  });
  const listScrolling = useSessionListScroll.use.scrolling();
  return (
    <li role="presentation" className="list-none">
      <TooltipPrimitive.Root disabled={listScrolling}>
        <TooltipPrimitive.Trigger
          render={
            <button
              id={props.resultId}
              data-session-row={session.threadId}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={props.isActive || undefined}
              aria-label={sessionRowLabel({
                title: session.title,
                statusLabel: isSettled ? "Settled" : null,
                projectName: session.projectName,
              })}
              onMouseMove={() => props.onHighlight(session.threadId)}
              onClick={() => props.onSelect(session)}
              onContextMenu={() => props.onMenuTarget(session)}
              className={cn(
                "group/sidebar-row flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isActive
                  ? "bg-element-selected text-foreground"
                  : "text-muted-foreground hover:bg-element-hover hover:text-foreground",
              )}
            />
          }
        >
          <ProjectBadge
            name={session.projectName}
            path={session.projectPath}
            className={cn(
              "transition-opacity",
              isSettled &&
                !props.isActive &&
                !props.isHighlighted &&
                "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0",
            )}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              isSettled
                ? "font-normal text-secondary-foreground/70 group-hover/sidebar-row:text-foreground"
                : "font-medium text-foreground",
              (props.isHighlighted || props.isActive) && "text-foreground",
            )}
          >
            {session.title}
          </span>
          <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted-foreground/55">
            <RelativeTime iso={session.updatedAt} />
          </span>
        </TooltipPrimitive.Trigger>
        <SessionHoverCardPopup session={session} status={status} />
      </TooltipPrimitive.Root>
    </li>
  );
});
