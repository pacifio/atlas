// A session's controls, at the right end of the window's title bar.
//
// The session's name is in the title bar already, as the breadcrumb's last
// segment, so nothing here repeats it. There used to be a second header row
// inside the session; the title bar has its own sidebar toggle, a new session
// is ⌘N or the sidebar's button, and the rest moved up here. The row's height
// went back to the transcript.
//
// The title bar's right end is two groups, kept to four controls on a
// session tab. This is the first, the session's, and it shows only on a
// session tab. The second, the window's (the right panel toggle, the
// account), never moves (`TopbarTrailing`). In order:
//
//  - the pinned-messages pill, only while something is pinned;
//  - Details: the session's card, docked where the chat panel keeps room at
//    its top-right, a popover under the button anywhere else
//    (`session-details-button.tsx`);
//  - the ⋯ menu, last: search in session, the role filter, pinned messages,
//    the Bash and Plans panels, and "branch from here" where the agent can
//    fork.
//
// Rendered by `ChatPanel`, which owns all of that state, and portalled into
// the column header's slot (`session-header-slot-store.ts`).

import { memo, useState, type RefObject } from "react";
import {
  ClipboardList,
  Ellipsis,
  GitBranch,
  ListFilter,
  Pin,
  Search,
  Sparkles,
  TerminalSquare,
  User,
} from "lucide-react";

import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { SessionDetailsButton } from "@/features/session-context/components/session-details-button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { HintItem } from "@/ui/hint-group";
import { IconButton } from "@/ui/icon-button";

import { pinsFor, useChatPinsStore, type ChatPin } from "../stores/chat-pins-store";
import { ChatPinnedMenu } from "./chat-pinned-menu";

export type RoleFilter = "all" | "user" | "assistant";

const ROLE_FILTERS: { value: RoleFilter; label: string; icon: typeof User }[] = [
  { value: "all", label: "All", icon: ListFilter },
  { value: "user", label: "User", icon: User },
  { value: "assistant", label: "Assistant", icon: Sparkles },
];

interface SessionHeaderControlsProps {
  tabId: string;
  /** The session's scope (`sessionScope`). */
  scope: string;
  /** Whether the chat panel has room to dock the Details card. */
  docked: boolean;
  /** The transcript's box: the Details popover is capped at its height, so
   *  it can never reach the composer below it. */
  stageRef: RefObject<HTMLElement | null>;
  onOpenSearch: () => void;
  roleFilter: RoleFilter;
  onRoleFilterChange: (f: RoleFilter) => void;
  /** Pin scope for this session (see `chat-pins-store`). */
  pinScopeKey: string;
  onJumpToPin: (pin: ChatPin) => void;
  bashPanelOpen: boolean;
  onToggleBash: () => void;
  plansPanelOpen: boolean;
  onTogglePlans: () => void;
  /** Only passed when the agent advertised `sessionCapabilities.fork`, so the
   *  menu never offers a branch that would fail on the wire. */
  onForkSession?: () => void;
}

// memo: rendered by ChatPanel once per streaming rAF flush; every prop is
// identity-stable there (strings/booleans/refs + the *Stable useCallback
// wrappers), so this bails per frame and re-renders only on real changes.
export const SessionHeaderControls = memo(function SessionHeaderControls({
  tabId,
  scope,
  docked,
  stageRef,
  onOpenSearch,
  roleFilter,
  onRoleFilterChange,
  pinScopeKey,
  onJumpToPin,
  bashPanelOpen,
  onToggleBash,
  plansPanelOpen,
  onTogglePlans,
  onForkSession,
}: SessionHeaderControlsProps) {
  const [pinsOpen, setPinsOpen] = useState(false);
  return (
    <div data-session-controls className="flex shrink-0 items-center gap-0.5">
      <ChatPinnedMenu
        pinScopeKey={pinScopeKey}
        onJump={onJumpToPin}
        open={pinsOpen}
        onOpenChange={setPinsOpen}
      />
      <SessionDetailsButton
        tabId={tabId}
        scope={scope}
        docked={docked}
        stageRef={stageRef}
        onOpenSearch={onOpenSearch}
      />
      <MoreMenu
        onOpenSearch={onOpenSearch}
        roleFilter={roleFilter}
        onRoleFilterChange={onRoleFilterChange}
        pinScopeKey={pinScopeKey}
        onOpenPins={() => setPinsOpen(true)}
        bashPanelOpen={bashPanelOpen}
        onToggleBash={onToggleBash}
        plansPanelOpen={plansPanelOpen}
        onTogglePlans={onTogglePlans}
        onForkSession={onForkSession}
      />
    </div>
  );
});

function MoreMenu({
  onOpenSearch,
  roleFilter,
  onRoleFilterChange,
  pinScopeKey,
  onOpenPins,
  bashPanelOpen,
  onToggleBash,
  plansPanelOpen,
  onTogglePlans,
  onForkSession,
}: {
  onOpenSearch: () => void;
  roleFilter: RoleFilter;
  onRoleFilterChange: (f: RoleFilter) => void;
  pinScopeKey: string;
  onOpenPins: () => void;
  bashPanelOpen: boolean;
  onToggleBash: () => void;
  plansPanelOpen: boolean;
  onTogglePlans: () => void;
  onForkSession?: () => void;
}) {
  const findHint = useActionShortcut("chat.find")?.label;
  const pinCount = useChatPinsStore((s) => pinsFor(s, pinScopeKey).length);
  return (
    <DropdownMenu>
      <HintItem label="Session options">
        <DropdownMenuTrigger
          render={<IconButton icon={Ellipsis} label="Session options" size="sm" iconSize="md" />}
        />
      </HintItem>
      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
        <DropdownMenuItem onClick={onOpenSearch}>
          <Search />
          <span className="flex-1">Search in session</span>
          {findHint && <DropdownMenuShortcut>{findHint}</DropdownMenuShortcut>}
        </DropdownMenuItem>
        {pinCount > 0 && (
          <DropdownMenuItem onClick={onOpenPins}>
            <Pin />
            <span className="flex-1">Pinned messages</span>
            <DropdownMenuShortcut className="tabular-nums">{pinCount}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show messages from</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={roleFilter}
            onValueChange={(v) => onRoleFilterChange(v as RoleFilter)}
          >
            {ROLE_FILTERS.map(({ value, label, icon: Icon }) => (
              <DropdownMenuRadioItem key={value} value={value}>
                <Icon />
                {label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={bashPanelOpen} onCheckedChange={onToggleBash}>
          <TerminalSquare />
          Bash calls
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem checked={plansPanelOpen} onCheckedChange={onTogglePlans}>
          <ClipboardList />
          Plans
        </DropdownMenuCheckboxItem>

        {onForkSession && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onForkSession}>
              <GitBranch />
              <span className="flex-1">Branch from here</span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
