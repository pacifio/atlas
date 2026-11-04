import { Bell, X } from "lucide-react";
import {
  Button,
  EmptyState,
  Hint,
  IconButton,
  Sheet,
  SheetContent,
  SheetTitle,
} from "@tryatlas/design";
import { timeAgo } from "@/lib/time-ago";
import type { NotificationAction } from "../../lib/catalog";
import type { AppNotification } from "../../lib/notification-groups";
import { NotificationLeadingIcon } from "../notification-leading-icon";

export interface NotificationPanelItem {
  notification: AppNotification;
  /** The buttons beyond "Open" that still apply; empty for most items. */
  actions: NotificationAction[];
}

export interface NotificationPanelGroup {
  label: string;
  items: NotificationPanelItem[];
}

export interface NotificationPanelViewProps {
  open: boolean;
  onClose: () => void;
  /** The drawer's width in px: it covers the surfaces pane exactly. */
  width: number;
  groups: NotificationPanelGroup[];
  hasItems: boolean;
  onOpen: (n: AppNotification) => void;
  onDismiss: (n: AppNotification) => void;
  onRunAction: (n: AppNotification, action: NotificationAction) => void;
  onClearAll: () => void;
}

/**
 * The notification drawer: the titlebar bell's day-grouped list, over the
 * right of the window.
 *
 * Non-modal on purpose, as it was before it was a Sheet: opening it does not
 * move focus in or trap it, and Esc does nothing; a click on the scrim (or an
 * item) closes it. It stays a `role="dialog"`, which is what the browser
 * overlay watcher looks for to hide the native webview underneath.
 */
export function NotificationPanelView({
  open,
  onClose,
  width,
  groups,
  hasItems,
  onOpen,
  onDismiss,
  onRunAction,
  onClearAll,
}: NotificationPanelViewProps) {
  return (
    <Sheet
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        if (!next && details.reason !== "escape-key") onClose();
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        initialFocus={false}
        finalFocus={false}
        aria-label="Notifications"
        data-view="notification-panel"
        style={{ width, maxWidth: "none" }}
      >
        {/* Header — matches the window titlebar height (30px). */}
        <div className="flex items-center gap-2 px-4 h-[30px] shrink-0 border-b border-border">
          <Bell size={13} className="text-secondary-foreground" strokeWidth={1.5} />
          <SheetTitle>Notifications</SheetTitle>
          <div className="flex-1" />
          {hasItems && (
            <Button variant="ghost" size="xs" onClick={onClearAll}>
              Clear all
            </Button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar">
          {!hasItems ? (
            <div className="grid h-full place-items-center">
              <EmptyState icon={Bell} title="No notifications" />
            </div>
          ) : (
            <div className="pb-3">
              {groups.map((g) => (
                <section key={g.label}>
                  <div className="sticky top-0 z-10 px-4 pt-3 pb-1.5 bg-card text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {g.label}
                  </div>
                  <div className="flex flex-col gap-1.5 px-3">
                    {g.items.map((item) => (
                      <NotificationCard
                        key={item.notification.id}
                        item={item}
                        onOpen={onOpen}
                        onDismiss={onDismiss}
                        onRunAction={onRunAction}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * One item. The card is a wrapper holding three siblings — the item's own
 * button, its action buttons and Dismiss — so no control sits inside another.
 */
function NotificationCard({
  item: { notification: n, actions },
  onOpen,
  onDismiss,
  onRunAction,
}: {
  item: NotificationPanelItem;
  onOpen: (n: AppNotification) => void;
  onDismiss: (n: AppNotification) => void;
  onRunAction: (n: AppNotification, action: NotificationAction) => void;
}) {
  return (
    <div
      className={
        "group relative rounded-xl border border-border-subtle bg-element-hover hover:bg-element-selected transition-colors " +
        // The time gives way to a keyboard-focused Dismiss, as it does on hover.
        "[&:has([data-dismiss]:focus-visible)_[data-notification-time]]:opacity-0"
      }
    >
      <button
        type="button"
        onClick={() => onOpen(n)}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left cursor-pointer select-none"
      >
        <span className="mt-0.5 shrink-0">
          <NotificationLeadingIcon kind={n.kind} agentType={n.agentType} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {!n.read && <span className="size-1.5 shrink-0 rounded-full bg-primary" />}
            <span className="truncate text-sm font-medium text-foreground">{n.title}</span>
            {/* Gives way to the Dismiss button, which takes its place on hover. */}
            <span
              data-notification-time
              className="ml-auto shrink-0 text-3xs text-muted-foreground tabular-nums transition-opacity group-hover:opacity-0"
            >
              {timeAgo(n.timestamp, { suffix: true })}
            </span>
          </span>
          {n.body && (
            <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-secondary-foreground">
              {n.body}
            </span>
          )}
        </span>
      </button>

      {actions.length > 0 && (
        // Lined up under the text: card padding + icon + gap.
        <div className="-mt-0.5 flex flex-wrap gap-1.5 pr-3 pb-2.5 pl-[38px]">
          {actions.map((a) => (
            <Button key={a.id} variant="outline" size="xs" onClick={() => onRunAction(n, a)}>
              {a.label}
            </Button>
          ))}
        </div>
      )}

      <span className="absolute right-2 top-2.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Hint label="Dismiss">
          <IconButton
            size="xs"
            icon={X}
            label="Dismiss"
            data-dismiss
            onClick={() => onDismiss(n)}
          />
        </Hint>
      </span>
    </div>
  );
}
