// In-app notification center — accumulates events from BOTH the agent chat and
// the general (model) chat, surfaced in a macOS-style right-side overlay panel.
// In-memory only (cleared on app restart); the OS-notification plumbing in
// App.tsx is separate and untouched.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

export type NotificationKind =
  | "agent-done"
  | "agent-failed"
  | "permission"
  | "chat-done"
  | "chat-error"
  | "terminal-done"
  | "terminal-failed"
  | "terminal-attention";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** ISO timestamp. */
  timestamp: string;
  source: "agent" | "chat" | "terminal";
  /** Provider id (chat source) — used to render the brand logo. */
  provider?: string;
  /** Originating session / tab, for best-effort click-to-focus. */
  sessionId?: string;
  tabId?: string;
  /** Terminal source: the layout terminal id inside `tabId`. */
  terminalId?: string;
  /** Owning workspace and organisation. Items are kept for every org and
   *  FILTERED by the active one at render (`visibleItems`); an untagged item
   *  is visible everywhere. */
  workspaceId?: string;
  orgId?: string;
  read: boolean;
}

/** Input for `add` — id/timestamp/read are filled in. */
export type NewNotification = Omit<AppNotification, "id" | "timestamp" | "read">;

const MAX_ITEMS = 200;

/** The active organisation's items. Untagged items (chat/agent before they
 *  carried an org) show everywhere. */
export function visibleItems(items: AppNotification[], orgId: string | null): AppNotification[] {
  if (!orgId) return items;
  return items.filter((i) => !i.orgId || i.orgId === orgId);
}

export function hasUnread(
  items: AppNotification[],
  orgId: string | null,
  pred: (i: AppNotification) => boolean = () => true,
): boolean {
  return items.some((i) => !i.read && (!orgId || !i.orgId || i.orgId === orgId) && pred(i));
}

const ERROR_KINDS: ReadonlySet<NotificationKind> = new Set([
  "agent-failed",
  "chat-error",
  "terminal-failed",
]);
export const isErrorKind = (i: AppNotification) => ERROR_KINDS.has(i.kind);

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `n-${Date.now()}-${Math.round(Math.random() * 1e9)}`;

interface NotificationsState {
  items: AppNotification[];
  panelOpen: boolean;
  actions: {
    add: (n: NewNotification) => void;
    dismiss: (id: string) => void;
    clearAll: () => void;
    markAllRead: () => void;
    /** Opening marks the VISIBLE items read — pass the active org so a look at
     *  org A's panel does not clear org B's unread state. */
    open: (orgId?: string | null) => void;
    close: () => void;
    toggle: (orgId?: string | null) => void;
  };
}

const markVisibleRead = (items: AppNotification[], orgId?: string | null) =>
  items.map((i) => (i.read || (orgId && i.orgId && i.orgId !== orgId) ? i : { ...i, read: true }));

export const useNotificationsStore = createSelectors(
  create<NotificationsState>((set) => ({
    items: [],
    panelOpen: false,
    actions: {
      add: (n) =>
        set((s) => ({
          items: [
            {
              ...n,
              id: uid(),
              timestamp: new Date().toISOString(),
              // If the panel is already open, count it as read immediately.
              read: s.panelOpen,
            },
            ...s.items,
          ].slice(0, MAX_ITEMS),
        })),
      dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
      clearAll: () => set({ items: [] }),
      markAllRead: () =>
        set((s) => ({ items: s.items.map((i) => (i.read ? i : { ...i, read: true })) })),
      open: (orgId) => set((s) => ({ panelOpen: true, items: markVisibleRead(s.items, orgId) })),
      close: () => set({ panelOpen: false }),
      toggle: (orgId) =>
        set((s) =>
          s.panelOpen
            ? { panelOpen: false }
            : { panelOpen: true, items: markVisibleRead(s.items, orgId) },
        ),
    },
  })),
);
