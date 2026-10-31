// The sidebar's destinations, one component each, so each subscribes to its
// own slice of the layout store. Team chat and Timeline are labelled rows;
// Usage sits icon-only beside search, and Memory, Knowledge, Source control
// and the bell are the footer's icon dock (`app-sidebar.tsx`). Each toggles what it opens (back to the
// session when it is already on screen) and lights while its view is the one
// showing. Team chat stays visible when it is locked, greyed, saying what
// unlocks it.
//
// No motion on any of them: they are pressed many times a day, and the view
// they open is the feedback. Hover is a colour step only.

import type { ComponentProps } from "react";
import { Bell, BookOpen, GitBranch, MessagesSquare, type LucideIcon } from "lucide-react";
import { Hint } from "@/ui/tooltip";
import { Icon } from "@/ui/icon";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  DESTINATIONS,
  destinationShown,
  toggleDestination,
} from "@/features/layout/lib/destinations";
import { sourceControlShown, toggleSourceControl } from "@/features/layout/lib/source-control";
import {
  teamChatDestinationShown,
  toggleTeamChatDestination,
} from "@/features/layout/lib/team-chat";
import { unlockHint, useTeamAccess } from "@/features/comms/lib/team-chat-access";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { hasUnreadConversation } from "@/features/comms/lib/derive";
import {
  hasUnread,
  useNotificationsStore,
} from "@/features/notifications/stores/notifications-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";

/** One destination: an icon and its label, lit while its view is on screen.
 *  `iconOnly` drops the label to the tooltip, for the sidebar's top row and
 *  its footer dock. */
export function DestinationButton({
  icon: IconGlyph,
  label,
  hint,
  active,
  locked,
  dot,
  disabled,
  iconOnly,
  hintSide,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  icon: LucideIcon;
  label: string;
  /** The tooltip, when it says more than the label (why it is disabled). */
  hint?: string;
  active?: boolean;
  /** What unlocks a destination this button cannot open yet. The button stays
   *  clickable (the click is the unlock, where there is one) and greyed. */
  locked?: string;
  /** A dot on the icon: something unread behind it. */
  dot?: boolean;
  /** A square, the label only in the tooltip. */
  iconOnly?: boolean;
  hintSide?: "top" | "right" | "bottom";
}) {
  // An icon-only button always has a tooltip: it is the only place the label
  // is written.
  const tip = locked ?? hint ?? (iconOnly ? label : undefined);
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      aria-disabled={locked ? true : undefined}
      data-locked={locked ? "" : undefined}
      disabled={disabled}
      className={cn(
        "flex shrink-0 cursor-pointer items-center rounded-md text-muted-foreground outline-none transition-colors duration-fast ease-out-strong",
        "hover:bg-element-hover hover:text-foreground focus-visible:bg-element-hover",
        "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        "data-locked:opacity-50",
        // The Settings sidebar's nav row (`settings-sidebar.tsx`), so the two
        // sidebars read as one app.
        iconOnly ? "size-7 justify-center" : "h-7 w-full gap-2.5 px-2",
        active && "bg-element-active text-foreground hover:bg-element-active",
        className,
      )}
      {...props}
    >
      <span className="relative flex shrink-0 items-center justify-center">
        <Icon icon={IconGlyph} size="md" aria-hidden />
        {dot && (
          <span
            data-testid="rail-dot"
            className="pointer-events-none absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-foreground"
          />
        )}
      </span>
      {iconOnly ? null : <span className="min-w-0 truncate text-sm leading-none">{label}</span>}
    </button>
  );
  if (!tip) return button;
  return (
    <Hint label={tip} side={hintSide ?? (iconOnly ? "top" : "right")}>
      {button}
    </Hint>
  );
}

const noop = () => {};

/** What the sidebar's top row and footer dock pass a destination button. */
type DockButtonProps = Pick<
  ComponentProps<typeof DestinationButton>,
  "iconOnly" | "hintSide" | "className"
>;

/** Team chat, as the destination (it is a surface too, from the surfaces
 *  pane's `+` and ⌘T); a dot while a conversation has anything unread (the
 *  server's counts), like the bell's. The selector answers a boolean, so a
 *  message landing re-renders the button only when the dot itself changes. */
export function TeamChatButton() {
  const open = useLayoutStore(teamChatDestinationShown);
  const access = useTeamAccess();
  const unread = useCommsStore((s) => hasUnreadConversation(s.reads, s.conversations));
  return (
    <DestinationButton
      icon={MessagesSquare}
      label="Team chat"
      active={open}
      locked={unlockHint(access, "team chat")}
      dot={unread && !access.locked}
      data-testid={unread && !access.locked ? "team-chat-unread" : undefined}
      onClick={access.locked ? (access.unlock ?? noop) : toggleTeamChatDestination}
    />
  );
}

export function TimelineButton() {
  const open = useLayoutStore((s) => destinationShown(s, "artifacts"));
  return (
    <DestinationButton
      icon={DESTINATIONS.artifacts.icon}
      label="Timeline"
      active={open}
      onClick={() => toggleDestination("artifacts")}
    />
  );
}

export function MemoryButton(props: DockButtonProps) {
  const open = useLayoutStore((s) => destinationShown(s, "memory"));
  return (
    <DestinationButton
      {...props}
      icon={DESTINATIONS.memory.icon}
      label="Memory"
      active={open}
      onClick={() => toggleDestination("memory")}
    />
  );
}

export function UsageButton(props: DockButtonProps) {
  const open = useLayoutStore((s) => destinationShown(s, "usage"));
  return (
    <DestinationButton
      {...props}
      icon={DESTINATIONS.usage.icon}
      label="Usage"
      active={open}
      onClick={() => toggleDestination("usage")}
    />
  );
}

// Knowledge and source control belong to a project; without one open they
// say so instead of opening a view with nothing in it.

export function KnowledgeButton(props: DockButtonProps) {
  const open = useLayoutStore((s) => destinationShown(s, "knowledge"));
  const hasProject = useAppStore((s) => !!s.currentProject);
  return (
    <DestinationButton
      {...props}
      icon={BookOpen}
      label="Knowledge"
      hint={hasProject ? undefined : "Open a project to open its knowledge base"}
      active={open}
      disabled={!hasProject}
      onClick={() => toggleDestination("knowledge")}
    />
  );
}

export function SourceControlButton(props: DockButtonProps) {
  const open = useLayoutStore(sourceControlShown);
  const hasProject = useAppStore((s) => !!s.currentProject);
  return (
    <DestinationButton
      {...props}
      icon={GitBranch}
      label="Source control"
      hint={hasProject ? undefined : "Open a project to see its source control"}
      active={open}
      disabled={!hasProject}
      onClick={toggleSourceControl}
    />
  );
}

/** Opens the notification drawer; a dot while the active org has unread. */
export function NotificationsButton(props: DockButtonProps) {
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  const unread = useNotificationsStore((s) => hasUnread(s.items, activeOrgId));
  const { toggle } = useNotificationsStore.use.actions();
  return (
    <DestinationButton
      {...props}
      icon={Bell}
      label="Notifications"
      dot={unread}
      onClick={() => toggle(activeOrgId)}
    />
  );
}
