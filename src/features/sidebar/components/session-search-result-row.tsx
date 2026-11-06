// A row in the header search's results: flat, one line, the settled ones
// dimmed. Highlighted by the search field's arrow keys, not by focus.

import { memo } from "react";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { cn } from "@/lib/utils";
import type { SidebarSession } from "../lib/sidebar-sessions";
import { useSessionListScroll } from "../lib/session-list-scroll";
import { resolveSessionRowStatus, sessionRowLabel } from "../lib/session-row-status";
import { ProjectBadge, RelativeTime } from "./session-row-parts";
import { SessionHoverCardPopup } from "./session-hover-card";

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
    heldWorking: session.heldWorking,
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
