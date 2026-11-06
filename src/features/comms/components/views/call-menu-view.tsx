import type { ReactNode } from "react";
import { ExternalLink, Link2, Phone, Users, Video } from "lucide-react";
import {
  Icon,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@tryatlas/design";
import type { CallMode } from "../../types";

/** One row of the start menu, as drawn. */
export interface CallStartRow {
  key: string;
  label: string;
  sub: string;
  /** Draw the guests glyph rather than the mode's. */
  guestIcon: boolean;
}

export interface CallMenuViewProps {
  mode: CallMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The start rows; `null` when the plan rules this button out. */
  options: CallStartRow[] | null;
  /** Why the button is ruled out (shown when `options` is null and nothing is live). */
  disabledReason: string;
  /** The row key whose start is in flight. */
  pending: string | null;
  /** A call is already live in this conversation. */
  liveCall: boolean;
  onStart: (key: string) => void;
  onJoinLive: () => void;
  onCopyLiveLink: () => void;
}

/**
 * One header call button (audio or video) and its blur menu: the start rows,
 * or Join / Copy link when a call is already live here.
 */
export function CallMenuView({
  mode,
  open,
  onOpenChange,
  options,
  disabledReason,
  pending,
  liveCall,
  onStart,
  onJoinLive,
  onCopyLiveLink,
}: CallMenuViewProps) {
  const glyph = mode === "video" ? Video : Phone;
  const label = mode === "video" ? "Start video call" : "Start voice call";

  // Ruled out by the plan, and nothing live to join: a disabled button that
  // says why. Focusable while disabled (`aria-disabled`), because a natively
  // disabled button fires no pointer events and the tooltip would never show.
  if (options === null && !liveCall) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <IconButton
              icon={glyph}
              label={`${label} — ${disabledReason}`}
              size="md"
              iconSize="md"
              disabled
              focusableWhenDisabled
            />
          }
        />
        <TooltipContent side="bottom" sideOffset={4}>
          {disabledReason}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* Tooltip OUTSIDE the popover trigger: both want to render the same
          element, and this nesting order is the one that keeps a single
          button. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <IconButton icon={glyph} label={label} size="md" iconSize="md" active={open} />
              }
            />
          }
        />
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        data-view="call-menu"
        surface="glass"
        align="end"
        sideOffset={6}
        className="w-[230px] select-none gap-0 px-0 py-1"
      >
        {liveCall ? (
          <>
            <div className="px-3 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              A call is already live here
            </div>
            <MenuRow
              icon={<Icon icon={ExternalLink} size="sm" />}
              label="Join ongoing call"
              onClick={onJoinLive}
            />
            <MenuRow
              icon={<Icon icon={Link2} size="sm" />}
              label="Copy call link"
              onClick={onCopyLiveLink}
            />
          </>
        ) : (
          (options ?? []).map((option) => (
            <MenuRow
              key={option.key}
              icon={
                pending === option.key ? (
                  <Spinner size="sm" label="" />
                ) : (
                  <Icon icon={option.guestIcon ? Users : glyph} size="sm" />
                )
              }
              label={pending === option.key ? "Starting…" : option.label}
              sub={option.sub}
              disabled={pending !== null}
              onClick={() => onStart(option.key)}
            />
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

function MenuRow({
  icon,
  label,
  sub,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  sub?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors duration-fast hover:bg-element-hover focus-visible:bg-element-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className="mt-px flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-foreground">{label}</span>
        {sub && (
          <span className="mt-px block text-2xs leading-snug text-muted-foreground">{sub}</span>
        )}
      </span>
    </button>
  );
}
