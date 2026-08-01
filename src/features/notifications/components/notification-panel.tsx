import { useMemo } from "react";
import { Bell, Shield, AlertTriangle, X, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { AtlasIcon } from "@/components/atlas-icon";
import { ProviderLogo } from "@/components/provider-logo";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  useNotificationsStore,
  type AppNotification,
} from "../stores/notifications-store";

/** Bucket a timestamp into a relative-day group label. */
function dayBucket(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function NotificationPanel() {
  const open = useNotificationsStore.use.panelOpen();
  const items = useNotificationsStore.use.items();
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
        className="fixed inset-0 z-[9998] bg-black/10 animate-fade-in"
        onClick={close}
        aria-hidden
      />
      <aside
        className={cn(
          "fixed right-0 top-0 bottom-0 z-[9999] w-[360px] flex flex-col",
          "border-l border-[var(--border-default)]",
          "bg-[var(--bg-elevated)]/60 backdrop-blur-2xl",
          "shadow-[var(--shadow-overlay)] animate-slide-in-right",
        )}
        role="dialog"
        aria-label="Notifications"
      >
        {/* Header — matches the window titlebar height (30px). */}
        <div className="flex items-center gap-2 px-4 h-[30px] shrink-0 border-b border-[var(--border-default)]">
          <Bell size={13} className="text-text-secondary" strokeWidth={1.5} />
          <span className="text-[12px] font-semibold text-text-primary">
            Notifications
          </span>
          <div className="flex-1" />
          {items.length > 0 && (
            <button
              onClick={clearAll}
              className="text-[10px] text-text-tertiary hover:text-text-primary transition-colors cursor-pointer"
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
                <div className="mx-auto grid h-11 w-11 place-items-center rounded-2xl border border-border-subtle bg-white/[0.03]">
                  <Bell
                    size={18}
                    className="text-text-tertiary"
                    strokeWidth={1.5}
                  />
                </div>
                <p className="mt-3 text-[12px] text-text-tertiary">
                  No notifications
                </p>
              </div>
            </div>
          ) : (
            <div className="pb-3">
              {groups.map((g) => (
                <section key={g.label}>
                  <div className="sticky top-0 z-10 px-4 pt-3 pb-1.5 bg-[var(--bg-elevated)]/40 backdrop-blur-sm text-[9px] font-semibold uppercase tracking-wider text-text-tertiary">
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
        "bg-white/[0.03] hover:bg-white/[0.06] transition-colors cursor-pointer select-none",
      )}
    >
      <span className="mt-0.5 shrink-0">
        <NotificationIcon n={n} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {!n.read && (
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent-primary)]" />
          )}
          <span className="truncate text-[12px] font-medium text-text-primary">
            {n.title}
          </span>
          <span className="ml-auto shrink-0 text-[9px] text-text-tertiary tabular-nums">
            {timeAgo(n.timestamp, { suffix: true })}
          </span>
        </div>
        {n.body && (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-text-secondary">
            {n.body}
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          dismiss(n.id);
        }}
        className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-100 grid h-5 w-5 place-items-center rounded-md text-text-tertiary hover:text-text-primary hover:bg-white/[0.08] transition-opacity"
        title="Dismiss"
      >
        <X size={11} />
      </button>
    </div>
  );
}

function NotificationIcon({ n }: { n: AppNotification }) {
  if (n.kind === "permission")
    return <Shield size={15} className="text-accent" strokeWidth={1.5} />;
  if (n.kind === "agent-failed" || n.kind === "chat-error")
    return (
      <AlertTriangle
        size={15}
        className="text-[var(--status-error)]"
        strokeWidth={1.5}
      />
    );
  if (n.kind === "chat-done" && n.provider)
    return <ProviderLogo id={n.provider} size={16} />;
  if (n.source === "agent")
    return <AtlasIcon size={16} className="rounded-[5px]" />;
  return (
    <Sparkles size={15} className="text-text-secondary" strokeWidth={1.5} />
  );
}

/** Best-effort: bring the originating chat into view. */
function focusNotification(n: AppNotification) {
  const layout = useLayoutStore.getState();
  if (n.source === "agent" && n.tabId) {
    layout.actions.setActiveTab(n.tabId);
    return;
  }
  if (n.source === "chat" && n.sessionId) {
    void import("@/features/model-chat/stores/model-chat-store").then(
      ({ useModelChatStore }) => {
        void useModelChatStore.getState().actions.selectSession(n.sessionId!);
      },
    );
    // Focus an existing model-chat tab, else open one.
    const existing = layout.tabs.find((t) => t.type === "model-chat");
    if (existing) {
      layout.actions.setActiveTab(existing.id);
    } else {
      layout.actions.addTab({
        id: `model-chat-${Date.now()}`,
        type: "model-chat",
        title: "Chat",
        closable: true,
        dirty: false,
        data: {},
      });
    }
  }
}
