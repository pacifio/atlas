// The pieces both row shapes draw from: the status labels, the snooze menu,
// the title (or its rename field), and the surface's class list. Props only;
// `session-row.tsx` is the container that resolves them.

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { CircleAlert, Clock, MessageCircleQuestion } from "lucide-react";
import { cn } from "@/lib/utils";
import { snoozePresets } from "@/features/chat/lib/session-snooze";
import type { SidebarSession } from "../../lib/sidebar-sessions";
import type { SessionRowStatus, SessionTopStatus } from "../../lib/session-row-status";
import { CircleDashedCheck, WorkingRing } from "../session-row-parts";
import {
  Hint,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from "@tryatlas/design";

/** Slot heights the list virtualizes on. A card renders 63px (three lines at
 *  Atlas's type scale) with 2px above and below; a slim or search row is 36px.
 *  The pinned drag maths shares the card slot, so the two stay in step. */
export const CARD_ROW_HEIGHT = 67;
export const SLIM_ROW_HEIGHT = 36;

/** What a drop would do to the row being dragged. */
export type SessionDropVerb = "pin" | "unpin";

export const TOP_STATUS: Record<SessionTopStatus, { label: string; className: string }> = {
  input: { label: "Needs input", className: "text-warning" },
  working: { label: "Working", className: "text-info" },
  failed: { label: "Failed", className: "text-error" },
  woke: { label: "Woke", className: "text-warning" },
  done: { label: "Done", className: "text-success" },
};

/** What the row surface itself answers to; the same in both shapes. */
export interface SessionRowSurfaceHandlers {
  onClick: (event: MouseEvent) => void;
  onDoubleClick: (event: MouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onContextMenu: () => void;
}

/** What both row shapes are given by the container. */
export interface SessionRowViewProps {
  session: SidebarSession;
  status: SessionRowStatus;
  topStatus: SessionTopStatus | null;
  shouldRecede: boolean;
  isUnread: boolean;
  isWoke: boolean;
  isActive: boolean;
  isRenaming: boolean;
  isDragging: boolean;
  accessibleLabel: string;
  hoverCardDisabled: boolean;
  surface: SessionRowSurfaceHandlers;
  onSettle: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
}

/** A click on a control inside the row: handled here, not as an open. */
export const stopThen = (run: () => void) => (event: MouseEvent) => {
  event.preventDefault();
  event.stopPropagation();
  run();
};

export function rowSurfaceClassName(props: {
  isActive: boolean;
  shouldRecede: boolean;
  status: SessionRowStatus;
  isDragging: boolean;
}): string {
  return cn(
    "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    props.isActive
      ? "bg-element-selected text-foreground"
      : props.shouldRecede
        ? "text-muted-foreground hover:bg-element-hover hover:text-foreground"
        : "bg-transparent text-foreground hover:bg-element-hover",
    props.shouldRecede &&
      props.status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
    props.isDragging && "bg-element-selected text-foreground opacity-100 shadow-lg",
  );
}

export function TopStatusIcon({ status }: { status: SessionTopStatus }) {
  if (status === "working") return <WorkingRing />;
  if (status === "input")
    return <MessageCircleQuestion aria-hidden className="size-3.5 shrink-0" />;
  if (status === "failed") return <CircleAlert aria-hidden className="size-3.5 shrink-0" />;
  if (status === "done") return <CircleDashedCheck />;
  return null;
}

export function SnoozeMenuButton({
  open,
  onOpenChange,
  onSnooze,
  onCustomSnooze,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (until: string) => void;
  /** "Custom…": the container asks for a time and snoozes until it. */
  onCustomSnooze: () => void;
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
          onClick={(event) => {
            event.stopPropagation();
            onCustomSnooze();
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
export function RowTitle({
  title,
  className,
  isRenaming,
  onCommit,
  onCancel,
}: {
  title: string;
  className: string;
  isRenaming: boolean;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(title);
  const committed = useRef(false);
  useEffect(() => {
    if (!isRenaming) return;
    committed.current = false;
    setDraft(title);
  }, [isRenaming, title]);
  if (!isRenaming) {
    return (
      <span aria-hidden dir="auto" className={className}>
        {title}
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
          onCommit(draft);
        } else if (event.key === "Escape") {
          event.preventDefault();
          committed.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        if (!committed.current) onCommit(draft);
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-border bg-panel-input px-1 text-sm font-medium text-foreground outline-none focus:border-border-strong"
    />
  );
}
