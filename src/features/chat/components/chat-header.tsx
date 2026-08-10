// The chat header.
//
// Deliberately close to ChatGPT's: a session name with a chevron on the left,
// and everything else folded behind icon buttons. The previous header put a
// 280px search field, a role-filter pill, and three named toggles (Bash /
// Plans / Zen) permanently on screen — five controls competing with the
// transcript, most of them rarely used.
//
// Every control in the bar is CONTROL_H tall and shares one outline treatment,
// so the row lines up on a single optical baseline. That is the whole design:
// one height, one border.
//
// The session picker reuses `SessionSidebar` in its `dropdown` variant rather
// than reimplementing the list. Building that list means merging live tabs with
// three agents' on-disk session listings and suppressing duplicates, and opening
// a row carries a lot of resume edge-cases — a second implementation would drift
// from the first within a release.

import { forwardRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  ChevronDown,
  Search,
  MoreHorizontal,
  TerminalSquare,
  ClipboardList,
  ListFilter,
  User,
  Sparkles,
  Check,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SessionSidebar } from "./session-sidebar";

export type RoleFilter = "all" | "user" | "assistant";

/**
 * One height for every control in the bar.
 *
 * Alignment here is not a matter of `items-center` — that centres boxes of
 * different heights, which still reads as ragged because the borders don't line
 * up. The pill and the circles have to be the SAME box.
 */
const CONTROL_H = "h-[26px]";

/**
 * The single control treatment, shared by the pill and all three circles.
 *
 * A faint fill carries the shape and the border only needs to finish the edge —
 * so the border is deliberately softer than it was when it was doing the job
 * alone (`#3a3a3a` ≈ 23% white; this is ~16%). Outline-only controls on a near
 * black header read as wireframes; fill-plus-whisper reads as a surface.
 *
 * White alphas rather than hex so the controls track the active theme and sit
 * correctly on the blurred band behind them, which is translucent.
 */
const OUTLINE = [
  "border border-white/[0.16] bg-white/[0.045] text-[var(--text-tertiary)]",
  "transition-colors hover:border-white/[0.22] hover:bg-white/[0.09] hover:text-[var(--text-primary)]",
].join(" ");

interface ChatHeaderProps {
  tabId: string;
  /** Shown on the picker trigger. */
  title: string;
  roleFilter: RoleFilter;
  onRoleFilterChange: (f: RoleFilter) => void;
  onOpenSearch: () => void;
  bashPanelOpen: boolean;
  onToggleBash: () => void;
  plansPanelOpen: boolean;
  onTogglePlans: () => void;
  onNewSession: () => void;
}

export function ChatHeader({
  tabId,
  title,
  roleFilter,
  onRoleFilterChange,
  onOpenSearch,
  bashPanelOpen,
  onToggleBash,
  plansPanelOpen,
  onTogglePlans,
  onNewSession,
}: ChatHeaderProps) {
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    // No border and NO BACKGROUND. The bar floats over the transcript (see the
    // absolute wrapper in ChatPanel) and the transcript draws a progressive blur
    // band behind it, so the thread stays visible-but-blurred underneath. Giving
    // this element a fill would hide the very effect it sits on.
    <div className="relative shrink-0">
      <div className="flex h-[46px] items-center gap-2 px-6">
        <HeaderCircleButton title="New session" onClick={onNewSession}>
          <Plus size={13} />
        </HeaderCircleButton>

        {/* Session picker */}
        <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
          <Popover.Trigger asChild>
            {/* Same outline as the circles, just pill-shaped. Bare text on a
                bare header gave no hint that the title was a control at all. */}
            <button
              type="button"
              className={cn(
                "flex min-w-0 max-w-[46%] items-center gap-1.5 rounded-full px-3",
                CONTROL_H,
                OUTLINE,
                "text-[12px] font-medium leading-none text-[var(--text-primary)]",
                "cursor-pointer outline-none",
              )}
              title="Switch session"
            >
              <span className="truncate">{title}</span>
              <ChevronDown
                size={12}
                className={cn(
                  "shrink-0 text-[var(--text-tertiary)] transition-transform",
                  pickerOpen && "rotate-180",
                )}
              />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="start"
              sideOffset={6}
              style={{
                zIndex: 9999,
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.95)",
                // No `will-change` — it would isolate the layer and flatten the blur.
              }}
              className={cn(
                "overflow-hidden rounded-xl select-none",
                // Border, translucent fill, blur AND the enter animation all on
                // THIS element. Splitting them isolates the layer and kills the
                // backdrop blur (see the feedback panel for the same rule).
                "border border-white/10 bg-[var(--bg-elevated)]/85 backdrop-blur-2xl",
                // Grows out of its trigger's top-left corner.
                "atlas-panel-in-tl",
              )}
            >
              {/* The sidebar's own search input is the combo box's filter. */}
              <SessionSidebar
                tabId={tabId}
                variant="dropdown"
                onOpened={() => setPickerOpen(false)}
              />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>

        <div className="flex-1" />

        <HeaderCircleButton title="Find in chat (⌘F)" onClick={onOpenSearch}>
          <Search size={13} />
        </HeaderCircleButton>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <HeaderCircleButton title="More">
              <MoreHorizontal size={14} />
            </HeaderCircleButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={6}
              style={{ zIndex: 9999 }}
              className="min-w-[180px] rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] py-1 shadow-[var(--shadow-overlay)]"
            >
              <MenuLabel>Filter messages</MenuLabel>
              {(["all", "user", "assistant"] as const).map((f) => (
                <DropdownMenu.Item
                  key={f}
                  onSelect={() => onRoleFilterChange(f)}
                  className={cn(
                    "flex h-[26px] cursor-default items-center gap-2 px-3 text-[11px] capitalize outline-none",
                    roleFilter === f
                      ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]",
                  )}
                >
                  {f === "user" ? (
                    <User size={11} />
                  ) : f === "assistant" ? (
                    <Sparkles size={11} />
                  ) : (
                    <ListFilter size={11} />
                  )}
                  <span className="flex-1">{f}</span>
                  {roleFilter === f && <Check size={11} />}
                </DropdownMenu.Item>
              ))}

              <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />

              <DropdownMenu.Item
                onSelect={onToggleBash}
                className="flex h-[26px] cursor-default items-center gap-2 px-3 text-[11px] text-[var(--text-secondary)] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <TerminalSquare size={11} />
                <span className="flex-1">Bash calls</span>
                {bashPanelOpen && <Check size={11} />}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                onSelect={onTogglePlans}
                className="flex h-[26px] cursor-default items-center gap-2 px-3 text-[11px] text-[var(--text-secondary)] outline-none hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              >
                <ClipboardList size={11} />
                <span className="flex-1">Plans</span>
                {plansPanelOpen && <Check size={11} />}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {/* No fade element here: the blur behind this bar is drawn by the
          transcript's top `GradualBlur`. A backdrop-filter can only blur what is
          painted behind it, so it has to live in the scroller's stacking
          context — not in a header that owns its own row. */}
    </div>
  );
}

/**
 * A round icon button: thin border, flat fill. That is the whole treatment.
 *
 * It briefly carried a gradient hairline across the top, borrowed from a wide
 * `px-10` pill where the top edge is a long straight run. A circle this small
 * has no straight top edge at all, so the line overshot the arc at both ends and
 * read as a bar floating above the button rather than as light on its rim. The
 * effect does not survive the shape; it was removed rather than tuned.
 *
 * `forwardRef` is required: Radix's `asChild` triggers clone this element and
 * hand it a ref, and without one the dropdown has nothing to anchor to.
 */
const HeaderCircleButton = forwardRef<
  HTMLButtonElement,
  {
    children: React.ReactNode;
    title: string;
    onClick?: () => void;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(function HeaderCircleButton({ children, title, onClick, className, ...rest }, ref) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "grid w-[26px] shrink-0 place-items-center rounded-full",
        CONTROL_H,
        OUTLINE,
        "cursor-pointer outline-none",
        className,
      )}
    >
      {children}
    </button>
  );
});

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-1.5 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}
