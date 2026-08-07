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
  | "chat-error";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** ISO timestamp. */
  timestamp: string;
  source: "agent" | "chat";
  /** Provider id (chat source) — used to render the brand logo. */
  provider?: string;
  /** Originating session / tab, for best-effort click-to-focus. */
  sessionId?: string;
  tabId?: string;
  read: boolean;
}

/** Input for `add` — id/timestamp/read are filled in. */
export type NewNotification = Omit<AppNotification, "id" | "timestamp" | "read">;

const MAX_ITEMS = 100;

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
    open: () => void;
    close: () => void;
    toggle: () => void;
  };
}

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
      open: () =>
        set((s) => ({
          panelOpen: true,
          items: s.items.map((i) => (i.read ? i : { ...i, read: true })),
        })),
      close: () => set({ panelOpen: false }),
      toggle: () =>
        set((s) =>
          s.panelOpen
            ? { panelOpen: false }
            : {
                panelOpen: true,
                items: s.items.map((i) => (i.read ? i : { ...i, read: true })),
              },
        ),
    },
  })),
);
