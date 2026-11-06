// The shelves' row: badge, title, and when it was settled — or, on the
// Snoozed shelf, how long until it wakes. Under the pointer the time gives way
// to the one control the shelf offers: Wake, Un-settle, or Settle.

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { AlarmClock, AlarmClockOff, Check, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@tryatlas/design";
import {
  AttachedMark,
  ProjectBadgeStack,
  RelativeTime,
  SnoozeRemaining,
} from "../session-row-parts";
import { SessionHoverCardPopup } from "../session-hover-card";
import {
  RowTitle,
  rowSurfaceClassName,
  stopThen,
  type SessionRowViewProps,
} from "./session-row-controls";

export interface SessionRowSlimViewProps extends SessionRowViewProps {
  onWake: () => void;
  onUnsettle: () => void;
}

export function SessionRowSlimView(props: SessionRowSlimViewProps) {
  const { session, status, shouldRecede, isRenaming } = props;
  const settled = session.settledAt !== null;
  const snoozed = session.snoozedUntil !== null;
  return (
    <li data-session-row={session.threadId} className="list-none">
      <TooltipPrimitive.Root disabled={props.hoverCardDisabled}>
        <TooltipPrimitive.Trigger
          render={
            <div
              role="button"
              tabIndex={0}
              aria-label={props.accessibleLabel}
              aria-current={props.isActive || undefined}
              data-testid="sidebar-row-slim"
              className={cn(rowSurfaceClassName(props), "flex h-9 items-center gap-2.5 px-2.5")}
              onClick={props.surface.onClick}
              onDoubleClick={props.surface.onDoubleClick}
              onKeyDown={props.surface.onKeyDown}
              onContextMenu={props.surface.onContextMenu}
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
            title={session.title}
            isRenaming={isRenaming}
            onCommit={props.onCommitRename}
            onCancel={props.onCancelRename}
            className={cn(
              "min-w-0 flex-1 truncate text-start text-sm transition-opacity group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground motion-reduce:transition-none",
              shouldRecede ? "font-normal" : "font-medium",
              shouldRecede
                ? "text-secondary-foreground/70"
                : props.isActive || props.isWoke || status === "input"
                  ? "text-foreground"
                  : props.isUnread
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
                    onClick={stopThen(props.onWake)}
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
                    onClick={stopThen(props.onUnsettle)}
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
                    onClick={stopThen(props.onSettle)}
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
