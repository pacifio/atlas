// The sidebar's foot: one row of destinations — the global views, then the
// open project's — and the notification bell. The account is the title bar's
// top-right avatar, and Settings and Help are in its menu: they are opened
// rarely, and a row of equal icons gave them the same weight as the views
// opened every hour.

import { Bell } from "lucide-react";
import { HintGroup } from "@/ui/hint-group";
import { Hint } from "@/ui/tooltip";
import { IconButton } from "@/ui/icon-button";
import {
  hasUnread,
  useNotificationsStore,
} from "@/features/notifications/stores/notifications-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import {
  KnowledgeButton,
  MemoryButton,
  SourceControlButton,
  TeamChatButton,
  TimelineButton,
  UsageButton,
} from "./sidebar-destinations";

export function SidebarFooter() {
  return (
    // Flush with the rail: no border, no layer of its own. A short fade from
    // the rail's colour is what separates the scrolling list from the row.
    <div className="relative flex shrink-0 px-2 pb-2 pt-1 before:pointer-events-none before:absolute before:inset-x-0 before:-top-4 before:h-4 before:bg-gradient-to-t before:from-sidebar before:to-transparent">
      {/* Tooltips open upward: the row sits on the window's bottom edge. */}
      <HintGroup side="top">
        <nav aria-label="Destinations" className="flex h-control-md flex-1 items-center gap-0.5">
          <TeamChatButton />
          <TimelineButton />
          <MemoryButton />
          <UsageButton />
          <span aria-hidden className="mx-1 h-4 w-px bg-border-subtle" />
          {/* The project's own views: greyed, saying why, with none open. */}
          <KnowledgeButton />
          <SourceControlButton />
          <span className="ml-auto flex">
            <NotificationsButton />
          </span>
        </nav>
      </HintGroup>
    </div>
  );
}

/** Opens the notification drawer; a dot while the active org has unread. */
function NotificationsButton() {
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  const unread = useNotificationsStore((s) => hasUnread(s.items, activeOrgId));
  const { toggle } = useNotificationsStore.use.actions();
  return (
    <Hint label="Notifications" side="top">
      <span className="relative flex">
        <IconButton
          icon={Bell}
          label="Notifications"
          size="sm"
          variant="ghost"
          onClick={() => toggle(activeOrgId)}
        />
        {unread && (
          <span className="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-foreground" />
        )}
      </span>
    </Hint>
  );
}
