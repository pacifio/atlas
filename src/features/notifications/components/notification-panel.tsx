import { useMemo } from "react";
import { Bell, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { timeAgo } from "@/lib/time-ago";
import { jumpToSession } from "@/features/chat/lib/tab-project";
import { jumpToTerminal } from "@/features/terminal/lib/jump-to-terminal";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { NotificationLeadingIcon } from "./notification-leading-icon";
import type { NotificationTarget } from "../lib/catalog";
import { openNotificationTarget } from "../lib/deliver";
import { hasNotificationAction, runNotificationAction } from "../lib/notification-actions";
import {
  useNotificationsStore,
  visibleItems,
  type AppNotification,
} from "../stores/notifications-store";

/** Bucket a timestamp into a relative-day group label. */
function dayBucket(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function NotificationPanel() {
  const open = useNotificationsStore.use.panelOpen();
  const allItems = useNotificationsStore.use.items();
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  // Org-scoped view over a global list: switching organisations must not
  // lose the other org's items, only hide them.
  const items = useMemo(() => visibleItems(allItems, activeOrgId), [allItems, activeOrgId]);
  const { close, clearAll } = useNotificationsStore.use.actions();

  // Preserve first-seen order within each day bucket (items are newest-first).
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: AppNotification[] }> = [];
    for (const n of items) {
      const label = dayBucket(n.timestamp);
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(n);
      else out.push({ label, items: [n] });
    }
    return out;
  }, [items]);

  if (!open) return null;

  return (
    <>
      {/* Scrim — subtle; the blurred panel carries the depth. */}
      <div
        className="fixed inset-0 z-drawer scrim-soft animate-fade-in"
        onClick={close}
        aria-hidden
      />
      <aside
        className={cn(
          "fixed right-0 top-0 bottom-0 z-drawer w-[360px] flex flex-col",
          "border-l border-[var(--border)]",
          "bg-[var(--card)]/60 backdrop-blur-2xl",
          "shadow-md animate-slide-in-right",
        )}
        role="dialog"
        aria-label="Notifications"
      >
        {/* Header — matches the window titlebar height (30px). */}
        <div className="flex items-center gap-2 px-4 h-[30px] shrink-0 border-b border-[var(--border)]">
          <Bell size={13} className="text-secondary-foreground" strokeWidth={1.5} />
          <span className="text-sm font-semibold text-foreground">Notifications</span>
          <div className="flex-1" />
          {items.length > 0 && (
            <button
              onClick={clearAll}
              className="text-2xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Timeline */}
        <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar">
          {items.length === 0 ? (
            <div className="grid h-full place-items-center px-6">
              <div className="text-center">
                <div className="mx-auto grid h-11 w-11 place-items-center rounded-2xl border border-border-subtle bg-element-hover">
                  <Bell size={18} className="text-muted-foreground" strokeWidth={1.5} />
                </div>
                <p className="mt-3 text-sm text-muted-foreground">No notifications</p>
              </div>
            </div>
          ) : (
            <div className="pb-3">
              {groups.map((g) => (
                <section key={g.label}>
                  <div className="sticky top-0 z-10 px-4 pt-3 pb-1.5 bg-[var(--card)]/40 backdrop-blur-sm text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {g.label}
                  </div>
                  <div className="flex flex-col gap-1.5 px-3">
                    {g.items.map((n) => (
                      <NotificationCard key={n.id} n={n} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}

function NotificationCard({ n }: { n: AppNotification }) {
  const { dismiss, close } = useNotificationsStore.use.actions();

  const onOpen = () => {
    close();
    focusNotification(n);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className={cn(
        "group relative flex items-start gap-2.5 rounded-xl border border-border-subtle px-3 py-2.5",
        "bg-element-hover hover:bg-element-selected transition-colors cursor-pointer select-none",
      )}
    >
      <span className="mt-0.5 shrink-0">
        <NotificationLeadingIcon kind={n.kind} agentType={n.agentType} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--primary)]" />}
          <span className="truncate text-sm font-medium text-foreground">{n.title}</span>
          {/* Gives way to the Dismiss button, which takes its place on hover. */}
          <span className="ml-auto shrink-0 text-3xs text-muted-foreground tabular-nums transition-opacity group-hover:opacity-0 group-has-[[data-dismiss]:focus-visible]:opacity-0">
            {timeAgo(n.timestamp, { suffix: true })}
          </span>
        </div>
        {n.body && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-secondary-foreground">
            {n.body}
          </p>
        )}
        <CardActions n={n} onRun={close} />
      </div>

      <Hint label="Dismiss">
        <button
          type="button"
          data-dismiss
          aria-label="Dismiss"
          onClick={(e) => {
            e.stopPropagation();
            dismiss(n.id);
          }}
          className="absolute right-2 top-2.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 grid h-5 w-5 place-items-center rounded-md text-muted-foreground hover:text-foreground hover:bg-element-active transition-opacity"
        >
          <X size={11} />
        </button>
      </Hint>
    </div>
  );
}

/** An item's buttons beyond "Open" — only while it still applies (not
 *  resolved) and a handler is registered for each. */
function CardActions({ n, onRun }: { n: AppNotification; onRun: () => void }) {
  const target = targetOf(n);
  const actions =
    n.resolved || !target ? [] : (n.actions ?? []).filter((a) => hasNotificationAction(a.id));
  if (!target || actions.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRun();
            void runNotificationAction(a.id, { kind: n.kind, target, args: a.args });
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="h-6 px-2 rounded-md border border-border text-2xs font-medium text-foreground bg-[var(--card)] hover:bg-element-active transition-colors"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/** The full target an item's actions run against: its app-level target, or
 *  the terminal / session it was raised from. */
function targetOf(n: AppNotification): NotificationTarget | null {
  if (n.target) return n.target;
  if (n.source === "terminal" && n.tabId && n.terminalId) {
    return { type: "terminal", tabId: n.tabId, terminalId: n.terminalId, projectId: n.projectId };
  }
  if (n.source === "agent" && n.tabId) {
    return { type: "session", tabId: n.tabId, sessionId: n.sessionId, projectId: n.projectId };
  }
  return null;
}

/** Best-effort: bring the originating chat, terminal or sign-in surface into view. */
function focusNotification(n: AppNotification) {
  if (n.target) {
    openNotificationTarget(n.target);
    return;
  }
  if (n.source === "terminal" && n.tabId) {
    void jumpToTerminal({ tabId: n.tabId, terminalId: n.terminalId, projectId: n.projectId });
    return;
  }
  if (n.source === "agent" && n.tabId) {
    // Project-aware: a bare setActiveTab on a tab from ANOTHER project
    // falls back to tabs[0] of the current one — jumpToSession switches to the
    // owning project first.
    void jumpToSession(n.tabId);
    return;
  }
}
