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

import { forwardRef, memo, useState } from "react";
import { MenuGlyph } from "@/ui/animated-icon";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { Popover } from "@base-ui/react/popover";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import {
  ChevronDown,
  Search,
  GitBranch,
  TerminalSquare,
  ClipboardList,
  ListFilter,
  MessageSquare,
  User,
  Sparkles,
  Check,
  Plus,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { SessionSidebar } from "./session-sidebar";
import { ChatPinnedMenu } from "./chat-pinned-menu";
import {
  SharedThreadPanel,
  useSharedThreadFor,
  type ShareTarget,
} from "@/features/shared-threads/components/shared-thread-panel";
import type { ChatPin } from "../stores/chat-pins-store";

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
 * alone (the previous solid-grey border was roughly 23% white; this is ~16%).
 * Outline-only controls on a near black header read as wireframes;
 * fill-plus-whisper reads as a surface.
 *
 * Foreground-tinted rather than white alphas, so the controls track the active
 * theme (a light appearance gets a dark outline, not an invisible white one)
 * and still sit correctly on the translucent blurred band behind them. The
 * border is mixed here rather than taken from `--border` / `--atlas-border-strong`:
 * those are opaque greys tuned for panel edges, dimmer than 16% at rest and a
 * much bigger jump than 22% on hover.
 */
const OUTLINE = [
  "border border-[color-mix(in_srgb,var(--foreground)_16%,transparent)] bg-[var(--atlas-element-hover)] text-[var(--muted-foreground)]",
  "transition-colors hover:border-[color-mix(in_srgb,var(--foreground)_22%,transparent)] hover:bg-[var(--atlas-element-active)] hover:text-[var(--foreground)]",
].join(" ");

interface ChatHeaderProps {
  tabId: string;
  /** Shown on the picker trigger. */
  title: string;
  roleFilter: RoleFilter;
  onRoleFilterChange: (f: RoleFilter) => void;
  onOpenSearch: () => void;
  /** Pin scope for this thread (see `chat-pins-store`). The pin count control
   *  renders itself away when the thread has no pins. */
  pinScopeKey: string;
  onJumpToPin: (pin: ChatPin) => void;
  bashPanelOpen: boolean;
  onToggleBash: () => void;
  plansPanelOpen: boolean;
  onTogglePlans: () => void;
  /** Comments on this session in the shared Timeline, or `null` when the
   *  session is not in the cloud — then there is no button at all. */
  commentCount: number | null;
  /** What the Share popover shares (ATL-395). */
  shareTarget: ShareTarget;
  commentsPanelOpen: boolean;
  onToggleComments: () => void;
  /** P3.4: only rendered when the agent advertised `sessionCapabilities.fork`.
   *  Absent for every agent that did not, so the menu never offers a branch
   *  that would fail on the wire. */
  onForkSession?: () => void;
  onNewSession: () => void;
}

// memo: rendered by ChatPanel once per streaming rAF flush; every prop is
// identity-stable there (strings/booleans + the *Stable useCallback wrappers),
// so this bails per frame and re-renders only on real header state changes.
export const ChatHeader = memo(ChatHeaderImpl);

function ChatHeaderImpl({
  tabId,
  title,
  roleFilter,
  onRoleFilterChange,
  onOpenSearch,
  pinScopeKey,
  onJumpToPin,
  bashPanelOpen,
  onToggleBash,
  plansPanelOpen,
  onTogglePlans,
  commentCount,
  shareTarget,
  commentsPanelOpen,
  onToggleComments,
  onForkSession,
  onNewSession,
}: ChatHeaderProps) {
  const findHint = useActionShortcut("chat.find")?.label;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    // No border and NO BACKGROUND. The bar floats over the transcript (see the
    // absolute wrapper in ChatPanel) and the transcript draws a progressive blur
    // band behind it, so the thread stays visible-but-blurred underneath. Giving
    // this element a fill would hide the very effect it sits on.
    <div className="relative shrink-0">
      <HintGroup>
        <div className="flex h-[46px] items-center gap-2 px-6">
          <HeaderCircleButton title="New session" onClick={onNewSession}>
            <Plus size={13} />
          </HeaderCircleButton>

          {/* Session picker */}
          <Popover.Root open={pickerOpen} onOpenChange={setPickerOpen}>
            <Popover.Trigger
              render={
                /* Same outline as the circles, just pill-shaped. Bare text on a
                bare header gave no hint that the title was a control at all. */
                <button
                  type="button"
                  className={cn(
                    "flex min-w-0 max-w-[46%] items-center gap-1.5 rounded-full px-3",
                    CONTROL_H,
                    OUTLINE,
                    "text-sm font-medium leading-none text-[var(--foreground)]",
                    "cursor-pointer outline-none",
                  )}
                  title="Switch session"
                >
                  <span className="truncate">{title}</span>
                  <ChevronDown
                    size={12}
                    className={cn(
                      "shrink-0 text-[var(--muted-foreground)] transition-transform",
                      pickerOpen && "rotate-180",
                    )}
                  />
                </button>
              }
            />
            <Popover.Portal>
              <Popover.Positioner className="z-popover" align="start" sideOffset={6}>
                <Popover.Popup
                  className={cn(
                    "overflow-hidden rounded-xl select-none inset-highlight shadow-md",
                    // Border, translucent fill, blur AND the enter animation all on
                    // THIS element. Splitting them isolates the layer and kills the
                    // backdrop blur (see the feedback panel for the same rule).
                    "border border-[var(--atlas-element-active)] bg-[var(--card)]/95 backdrop-blur-2xl",
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
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>

          <div className="flex-1" />

          {/* Left of Find, so the two "go back to something" controls sit
            together at the right end of the bar. Pill-shaped rather than a
            circle because it carries a count. */}
          <ChatPinnedMenu
            pinScopeKey={pinScopeKey}
            onJump={onJumpToPin}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full px-2.5",
              CONTROL_H,
              OUTLINE,
              "cursor-pointer outline-none",
            )}
          />

          {/* Only on a session the Organisation can see. The badge counts
              comments, capped where the circle runs out of room. */}
          {commentCount !== null && (
            <HeaderCircleButton
              title={commentsPanelOpen ? "Close comments" : "Comments"}
              onClick={onToggleComments}
              aria-pressed={commentsPanelOpen}
              className={cn(
                "relative",
                commentsPanelOpen && "bg-[var(--atlas-element-active)] text-[var(--foreground)]",
              )}
            >
              <MessageSquare size={13} />
              {commentCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-[var(--primary)] px-1 font-mono text-3xs leading-none text-[var(--primary-foreground)] tabular-nums">
                  {commentCount > 9 ? "9+" : commentCount}
                </span>
              )}
            </HeaderCircleButton>
          )}

          <ShareThreadButton target={shareTarget} />

          <HeaderCircleButton
            title={findHint ? `Find in chat (${findHint})` : "Find in chat"}
            onClick={onOpenSearch}
          >
            <Search size={13} />
          </HeaderCircleButton>

          {/* `onOpenChange` on an otherwise uncontrolled Root: the glyph needs
              to know the menu is open, but nothing else here does, so lifting
              the open state outright would buy a re-render for no reason. */}
          <DropdownMenu.Root onOpenChange={setMoreOpen}>
            <DropdownMenu.Trigger
              render={
                <HeaderCircleButton title="More">
                  <MenuGlyph active={moreOpen} size="md" />
                </HeaderCircleButton>
              }
            />
            <DropdownMenu.Portal>
              <DropdownMenu.Positioner className="z-popover" align="end" sideOffset={6}>
                <DropdownMenu.Popup className="min-w-[180px] rounded-md border border-[var(--border)] bg-[var(--card)] py-1 shadow-md">
                  <MenuLabel>Filter messages</MenuLabel>
                  {(["all", "user", "assistant"] as const).map((f) => (
                    <DropdownMenu.Item
                      key={f}
                      onClick={() => onRoleFilterChange(f)}
                      className={cn(
                        "flex h-[26px] cursor-default items-center gap-2 px-3 text-xs capitalize outline-none",
                        roleFilter === f
                          ? "bg-[var(--atlas-element-selected)] text-[var(--foreground)]"
                          : "text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]",
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

                  <DropdownMenu.Separator className="my-1 h-px bg-[var(--atlas-border-subtle)]" />

                  <DropdownMenu.Item
                    onClick={onToggleBash}
                    className="flex h-[26px] cursor-default items-center gap-2 px-3 text-xs text-[var(--secondary-foreground)] outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
                  >
                    <TerminalSquare size={11} />
                    <span className="flex-1">Bash calls</span>
                    {bashPanelOpen && <Check size={11} />}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={onTogglePlans}
                    className="flex h-[26px] cursor-default items-center gap-2 px-3 text-xs text-[var(--secondary-foreground)] outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
                  >
                    <ClipboardList size={11} />
                    <span className="flex-1">Plans</span>
                    {plansPanelOpen && <Check size={11} />}
                  </DropdownMenu.Item>
                  {onForkSession && (
                    <>
                      <DropdownMenu.Separator className="my-1 h-px bg-[var(--atlas-border-subtle)]" />
                      <DropdownMenu.Item
                        onClick={onForkSession}
                        className="flex h-[26px] cursor-default items-center gap-2 px-3 text-xs text-[var(--secondary-foreground)] outline-none hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
                      >
                        <GitBranch size={11} />
                        <span className="flex-1">Branch from here</span>
                      </DropdownMenu.Item>
                    </>
                  )}
                </DropdownMenu.Popup>
              </DropdownMenu.Positioner>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </HintGroup>

      {/* No fade element here: the blur behind this bar is drawn by the
          transcript's top `GradualBlur`. A backdrop-filter can only blur what is
          painted behind it, so it has to live in the scroller's stacking
          context — not in a header that owns its own row. */}
    </div>
  );
}

/**
 * Share this thread, join one from a link, and see what is joined (ATL-395).
 * Filled while the thread shown is a Shared Thread, so its state reads at a
 * glance without opening anything.
 */
function ShareThreadButton({ target }: { target: ShareTarget }) {
  const [open, setOpen] = useState(false);
  const current = useSharedThreadFor(target.sessionId);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <HeaderCircleButton
            title={current ? `Shared thread · ${current.status.connected ? "live" : "offline"}` : "Share thread"}
            aria-pressed={current !== null}
            className={cn(
              "relative",
              current && "bg-[var(--atlas-element-active)] text-[var(--foreground)]",
            )}
          >
            <Users size={13} />
            {current?.status.connected && (
              <span className="absolute -right-0.5 -top-0.5 size-[7px] rounded-full bg-success" />
            )}
          </HeaderCircleButton>
        }
      />
      <Popover.Portal>
        <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
          <Popover.Popup
            className={cn(
              "overflow-hidden rounded-xl inset-highlight shadow-md",
              "border border-[var(--atlas-element-active)] bg-[var(--card)]/95 backdrop-blur-2xl",
            )}
          >
            <SharedThreadPanel target={target} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
 * `forwardRef` is required: a trigger's `render` clones this element and hands
 * it a ref, and without one the dropdown has nothing to anchor to.
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
    <HintItem label={title}>
      <button
        {...rest}
        ref={ref}
        type="button"
        onClick={onClick}
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
    </HintItem>
  );
});

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-1.5 text-3xs uppercase tracking-wider text-[var(--muted-foreground)]">
      {children}
    </div>
  );
}
