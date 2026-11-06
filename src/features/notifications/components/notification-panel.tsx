import { useLayoutEffect, useMemo, useState } from "react";
import { jumpToSession } from "@/features/chat/lib/tab-project";
import { jumpToTerminal } from "@/features/terminal/lib/jump-to-terminal";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import type { NotificationAction, NotificationTarget } from "../lib/catalog";
import { openNotificationTarget } from "../lib/deliver";
import { hasNotificationAction, runNotificationAction } from "../lib/notification-actions";
import { groupNotificationsByDay } from "../lib/notification-groups";
import {
  useNotificationsStore,
  visibleItems,
  type AppNotification,
} from "../stores/notifications-store";
import {
  NotificationPanelView,
  type NotificationPanelGroup,
} from "./views/notification-panel-view";

/** Drawer width when no surfaces pane is on screen. */
const FALLBACK_WIDTH = 360;

/**
 * The on-screen surfaces pane's width, measured from the left edge of its
 * first visible column to the window's right edge, so the drawer covers
 * exactly the right panel. Collapsed columns and background projects measure
 * zero and are skipped; with none visible, the fallback width.
 */
function useSurfacesPaneWidth(active: boolean): number {
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  useLayoutEffect(() => {
    if (!active) return;
    const query = () => document.querySelectorAll<HTMLElement>("[data-surface-column]");
    // Re-queried on every pass, so a column added, removed or promoted to
    // main while the drawer is open is never measured from a stale list.
    const measure = () => {
      let left = Infinity;
      let right = -Infinity;
      for (const el of query()) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
      }
      setWidth(left === Infinity ? FALLBACK_WIDTH : Math.round(right - left));
    };
    measure();
    const ro = new ResizeObserver(measure);
    for (const el of query()) ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active]);
  return width;
}

export function NotificationPanel() {
  const open = useNotificationsStore.use.panelOpen();
  const allItems = useNotificationsStore.use.items();
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  // Org-scoped view over a global list: switching organisations must not
  // lose the other org's items, only hide them.
  const items = useMemo(() => visibleItems(allItems, activeOrgId), [allItems, activeOrgId]);
  const { close, clearAll, dismiss } = useNotificationsStore.use.actions();
  const width = useSurfacesPaneWidth(open);

  // Preserve first-seen order within each day bucket (items are newest-first).
  const groups = useMemo<NotificationPanelGroup[]>(
    () =>
      groupNotificationsByDay(items, new Date()).map((g) => ({
        label: g.label,
        items: g.items.map((n) => ({ notification: n, actions: actionsFor(n) })),
      })),
    [items],
  );

  return (
    <NotificationPanelView
      open={open}
      onClose={close}
      width={width}
      groups={groups}
      hasItems={items.length > 0}
      onOpen={(n) => {
        close();
        focusNotification(n);
      }}
      onDismiss={(n) => dismiss(n.id)}
      onRunAction={(n, a) => {
        const target = targetOf(n);
        if (!target) return;
        close();
        void runNotificationAction(a.id, { kind: n.kind, target, args: a.args });
      }}
      onClearAll={clearAll}
    />
  );
}

/** An item's buttons beyond "Open" — only while it still applies (not
 *  resolved) and a handler is registered for each. */
function actionsFor(n: AppNotification): NotificationAction[] {
  if (n.resolved || !targetOf(n)) return [];
  return (n.actions ?? []).filter((a) => hasNotificationAction(a.id));
}

/** The full target an item's actions run against: its app-level target, or
 *  the terminal / session it was raised from. */
function targetOf(n: AppNotification): NotificationTarget | null {
  if (n.target) return n.target;
  if (n.source === "terminal" && n.tabId && n.terminalId) {
    return { type: "terminal", tabId: n.tabId, terminalId: n.terminalId, projectId: n.projectId };
  }
  if (n.source === "agent" && (n.tabId || n.threadId)) {
    return {
      type: "session",
      tabId: n.tabId ?? "",
      sessionId: n.sessionId,
      threadId: n.threadId,
      projectId: n.projectId,
    };
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
  const target = n.source === "agent" && n.threadId ? targetOf(n) : null;
  if (target) {
    // No tab may show it any more: resumed from history by its thread id.
    void openNotificationTarget(target);
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
