// The pinned and active sessions' row: the project on top (badge, name, pin)
// with the status slot at its end, the title under it, and the branch, its
// pull request and the agent on the third line.
//
// The status slot swaps on hover. At rest it says what the session is doing
// or, for a quiet one, how long ago it moved; under the pointer it gives way
// to snooze and Settle. A Woke marker stays put: it is a button (it dismisses
// itself).

import type { CSSProperties, PointerEvent } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { AlarmClock, Check, GitBranch, Pin, PinOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@tryatlas/design";
import {
  AttachedMark,
  ProjectBadgeStack,
  RelativeTime,
  SessionAgentIcon,
  WorkingDuration,
} from "../session-row-parts";
import { SessionPullRequestBadge } from "../session-pull-request";
import { SessionHoverCardPopup } from "../session-hover-card";
import {
  RowTitle,
  SnoozeMenuButton,
  TOP_STATUS,
  TopStatusIcon,
  rowSurfaceClassName,
  stopThen,
  type SessionDropVerb,
  type SessionRowViewProps,
} from "./session-row-controls";

export interface SessionRowCardViewProps extends SessionRowViewProps {
  isPinned: boolean;
  /** Pixels the row is moved by a drag in progress (its own, or a sibling
   *  making room); `0` at rest. */
  dragOffset: number;
  dropVerb: SessionDropVerb | null;
  /** The tab running the session, when it is open; its turn clock is read. */
  liveTabId: string | null;
  settleShortcut: string | null;
  snoozeMenuOpen: boolean;
  onSnoozeMenuOpenChange: (open: boolean) => void;
  /** The pull request badge's hover list opened or closed. */
  onBadgeOpenChange: (open: boolean) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onSnooze: (until: string) => void;
  onCustomSnooze: () => void;
  onUnpin: () => void;
  onAcknowledgeWoke: () => void;
}

export function SessionRowCardView(props: SessionRowCardViewProps) {
  const { session, status, topStatus, shouldRecede, isRenaming, snoozeMenuOpen } = props;
  const isWokeStatus = topStatus === "woke";

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
        onClick={stopThen(props.onAcknowledgeWoke)}
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
        onClick={stopThen(props.onUnpin)}
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

  return (
    <li
      data-session-row={session.threadId}
      style={dragStyle}
      className={cn("list-none py-0.5", props.isDragging && "relative z-drag")}
    >
      <TooltipPrimitive.Root disabled={props.hoverCardDisabled}>
        <TooltipPrimitive.Trigger
          render={
            <div
              role="button"
              tabIndex={0}
              aria-label={props.accessibleLabel}
              aria-current={props.isActive || undefined}
              data-testid="sidebar-row-card"
              className={rowSurfaceClassName(props)}
              onClick={props.surface.onClick}
              onDoubleClick={props.surface.onDoubleClick}
              onKeyDown={props.surface.onKeyDown}
              onContextMenu={props.surface.onContextMenu}
              onPointerDown={props.onPointerDown}
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
                      onOpenChange={props.onSnoozeMenuOpenChange}
                      onSnooze={props.onSnooze}
                      onCustomSnooze={props.onCustomSnooze}
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
                        onClick={stopThen(props.onSettle)}
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
                title={session.title}
                isRenaming={isRenaming}
                onCommit={props.onCommitRename}
                onCancel={props.onCancelRename}
                className={cn(
                  "min-w-0 flex-1 truncate text-start text-sm transition-opacity motion-reduce:transition-none",
                  shouldRecede ? "font-normal" : "font-medium",
                  shouldRecede
                    ? "text-secondary-foreground"
                    : props.isUnread || props.isWoke || status === "input"
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
              <SessionPullRequestBadge session={session} onOpenChange={props.onBadgeOpenChange} />
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
}
