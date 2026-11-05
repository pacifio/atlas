import type { ReactElement, ReactNode } from "react";
import {
  ChevronLeft,
  FileText,
  Folder,
  Frame,
  Hash,
  Lock,
  MessageCircle,
  Pencil,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  Hint,
  Icon,
  IconButton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { CommsAvatar } from "../comms-avatar";
/** Mirrors the store's `ConvSubTab` (a view may not import the store module). */
type ConvSubTab = "messages" | "drafts" | "files";
import type { ChatConversation, OrgMemberProfile } from "../../types";

export interface ConversationHeaderViewProps {
  kind: ChatConversation["kind"];
  visibility: ChatConversation["visibility"];
  title: string;
  /** A 1:1 DM's other person (`null` when unresolved). */
  counterpart: OrgMemberProfile | null;
  counterpartOnline: boolean;
  /** Everyone in a group DM, me included. */
  groupSize: number;
  projectCount: number;
  /** Channels and group DMs: up to three other members, in order
   *  (`member` is `null` when the id is unresolved). */
  avatars: { id: string; member: OrgMemberProfile | null }[];
  /** Absent: no back button (the split view's sidebar is the way back). */
  onBack?: () => void;
  /** The pin count and its menu; `null` when nothing is pinned. */
  pinnedSlot: ReactNode | null;
  /** The audio and video call menus. */
  callSlot: ReactNode;
  /** Channels only: wraps the title button in the rename menu. */
  renameMenu?: (trigger: ReactElement) => ReactNode;
}

/**
 * The conversation's header.
 *
 * Two zones, not three: the title sits at the START, next to the back button,
 * and everything else is one right-hand action rail. It used to be optically
 * centred between two `flex-1` rails, which only works while the actions stay
 * light — calls, and whatever follows them, make the right side grow, and a
 * centred title would drift with every addition. `min-w-0` on both keeps a long
 * name truncating rather than shoving the buttons off the edge.
 */
export function ConversationHeaderView({
  kind,
  visibility,
  title,
  counterpart,
  counterpartOnline,
  groupSize,
  projectCount,
  avatars,
  onBack,
  pinnedSlot,
  callSlot,
  renameMenu,
}: ConversationHeaderViewProps) {
  const isChannel = kind === "channel";
  const isGroup = kind === "group_dm";

  return (
    <div
      data-view="comms-conversation-header"
      className="flex h-[38px] shrink-0 items-center gap-1 border-b border-border px-2"
    >
      {onBack ? (
        <Hint label="Back to chats">
          <IconButton
            icon={ChevronLeft}
            label="Back to chats"
            size="md"
            iconSize="md"
            onClick={onBack}
          />
        </Hint>
      ) : null}

      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {isChannel ? (
          <Icon
            icon={visibility === "private" ? Lock : Hash}
            size="sm"
            className="text-muted-foreground"
          />
        ) : isGroup ? (
          <Icon icon={Users} size="sm" className="text-muted-foreground" />
        ) : (
          <CommsAvatar member={counterpart} size={18} online={counterpartOnline} />
        )}
        {renameMenu ? (
          // Members may rename a channel (the server checks); hover reveals the
          // pencil, and DMs never get one — a name there is refused outright.
          renameMenu(
            <button
              type="button"
              title="Rename channel"
              className="group/title flex min-w-0 cursor-pointer items-center gap-1 text-left"
            >
              <span className="min-w-0 truncate text-base font-medium text-foreground">
                {title}
              </span>
              <span className="flex shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast group-hover/title:opacity-100">
                <Icon icon={Pencil} size="xs" />
              </span>
            </button>,
          )
        ) : (
          <span className="min-w-0 truncate text-base font-medium text-foreground">{title}</span>
        )}

        {isGroup && (
          <span className="shrink-0 text-2xs text-disabled">{groupSize} · membership frozen</span>
        )}
        {isChannel && projectCount > 0 && (
          <span className="shrink-0 rounded bg-element-hover px-1 py-px text-3xs text-muted-foreground">
            {projectCount} project
          </span>
        )}
      </div>

      {/* The action rail: what this conversation HAS (pins), then a rule,
          then what you can DO to it (call). The divider only appears when
          there is something on both sides of it to separate. */}
      <div className="flex shrink-0 items-center gap-0.5">
        {pinnedSlot && (
          <>
            {pinnedSlot}
            <div className="mx-1 h-4 w-px bg-border" />
          </>
        )}
        <div className="flex items-center gap-0.5">{callSlot}</div>
        {avatars.length > 0 && (
          <div className="flex items-center -space-x-1.5 pl-1">
            {avatars.map(({ id, member }) => (
              <Tooltip key={id}>
                <TooltipTrigger
                  render={
                    /* Wrapped: the trigger needs an element that takes a ref
                      and the ring must stay on the avatar itself. */
                    <span className="inline-flex">
                      <CommsAvatar
                        member={member}
                        size={18}
                        className="rounded-full ring-2 ring-background"
                      />
                    </span>
                  }
                />
                <TooltipContent side="bottom" sideOffset={4}>
                  {member?.name ?? "Unknown"}
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const TABS: { id: ConvSubTab; label: string; icon: LucideIcon }[] = [
  { id: "messages", label: "Messages", icon: MessageCircle },
  { id: "drafts", label: "Drafts", icon: FileText },
  { id: "files", label: "Files", icon: Folder },
];

/**
 * The Slack-style sub-tab strip, at Atlas scale: an underline marks the active
 * tab. Messages is the transcript; Drafts and Files are the conversation's
 * other faces.
 *
 * Plain buttons rather than the package `Tabs`: each sub-tab is its own Tab
 * stop, activated by click, Enter or Space, with no arrow-key roving — the
 * package's tablist roves, which would change the keyboard model.
 */
export function ConversationTabsView({
  active,
  onSelect,
  onOpenSpace,
}: {
  active: ConvSubTab;
  onSelect: (tab: ConvSubTab) => void;
  /** The realtime canvas (ATL-252) — opens as a CENTER tab, one per conversation. */
  onOpenSpace: () => void;
}) {
  return (
    <div className="flex h-[36px] shrink-0 items-center gap-0.5 border-b border-border px-2">
      {TABS.map(({ id, label, icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          className={cn(
            "relative flex h-full cursor-pointer items-center gap-1.5 px-2.5 text-sm font-medium transition-colors duration-fast",
            active === id
              ? "text-foreground"
              : "text-muted-foreground hover:text-secondary-foreground",
          )}
        >
          <span className="flex opacity-80">
            <Icon icon={icon} size="sm" />
          </span>
          {label}
          {active === id && (
            <span className="absolute inset-x-2 bottom-0 h-[1.5px] rounded-full bg-foreground" />
          )}
        </button>
      ))}

      <Hint label="Open this conversation's Space">
        <Button variant="outline" size="xs" className="ml-auto" onClick={onOpenSpace}>
          <Icon icon={Frame} size="sm" />
          Spaces
        </Button>
      </Hint>
    </div>
  );
}
