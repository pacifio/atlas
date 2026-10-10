// In-app notification center — the record behind the titlebar bell and the
// right-side overlay panel. Fed by the notification pipeline
// (`lib/deliver.ts`) — terminal and agent sources alike.
// Items persist across restarts (localStorage, capped at MAX_ITEMS); the
// panel's open state does not.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";
import {
  isNotificationKind,
  isNotificationSettingsSection,
  OPEN_ACTION_ID,
  type NotificationAction,
  type NotificationKind,
  type NotificationSource,
  type NotificationTarget,
  type TabTarget,
} from "../lib/catalog";

export type { NotificationKind, NotificationSource } from "../lib/catalog";

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  /** ISO timestamp. */
  timestamp: string;
  source: NotificationSource;
  /** Originating session / tab, for best-effort click-to-focus. */
  sessionId?: string;
  tabId?: string;
  /** Terminal source: the layout terminal id inside `tabId`. */
  terminalId?: string;
  /** Owning project and organisation. Items are kept for every org and
   *  FILTERED by the active one at render (`visibleItems`); an untagged item
   *  is visible everywhere. */
  projectId?: string;
  orgId?: string;
  /** The originating agent (agent kinds) — resolved to its icon by the
   *  registry-aware agent glyph. Absent on items from before it was stored. */
  agentType?: string;
  /** App-level target (a sign-in surface, a Chat conversation) for items that
   *  own no tab. */
  target?: Exclude<NotificationTarget, TabTarget>;
  /** Buttons beyond "Open" (the card itself opens), shown until the thing
   *  the notification was about is resolved. Absent on older items. */
  actions?: NotificationAction[];
  /** The notification no longer applies (`clearResolved`): read, and its
   *  actions are gone — a stale "Rebase or merge…" must not outlive the
   *  divergence it offered to fix. */
  resolved?: boolean;
  read: boolean;
}

/** Input for `add` — id/timestamp/read are filled in. */
export type NewNotification = Omit<AppNotification, "id" | "timestamp" | "read">;

const MAX_ITEMS = 200;

/** The active organisation's items. Untagged items (agent items before they
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
  "agent-disconnected",
  "terminal-failed",
  "atlas-signed-out",
  "agent-sign-in",
  "model-download-failed",
  "git-op-failed",
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
    /** Mark one session's items of a kind read (its question was answered). */
    markSessionKindRead: (sessionId: string, kind: NotificationKind) => void;
    /** Mark unread items of a kind (optionally narrowed) read — the thing they
     *  were about is resolved. */
    markKindRead: (kind: NotificationKind, match?: (i: AppNotification) => boolean) => void;
    /** Mark every unread item the predicate accepts as read. */
    markReadWhere: (match: (i: AppNotification) => boolean) => void;
    /** The matching items no longer apply: mark them read and drop their
     *  actions. */
    resolveWhere: (match: (i: AppNotification) => boolean) => void;
    /** Opening marks the VISIBLE items read — pass the active org so a look at
     *  org A's panel does not clear org B's unread state. */
    open: (orgId?: string | null) => void;
    close: () => void;
    toggle: (orgId?: string | null) => void;
  };
}

const markVisibleRead = (items: AppNotification[], orgId?: string | null) =>
  items.map((i) => (i.read || (orgId && i.orgId && i.orgId !== orgId) ? i : { ...i, read: true }));

const MAX_ACTIONS = 2;

/** Well-formed actions beyond "Open", at most `MAX_ACTIONS`; undefined when
 *  none remain. Whether a handler still exists is checked at render — the
 *  registry fills as modules load, after the persisted list is read. */
export function cleanActions(actions: unknown): NotificationAction[] | undefined {
  if (!Array.isArray(actions)) return undefined;
  const kept = actions
    .filter(
      (a): a is NotificationAction =>
        !!a &&
        typeof a === "object" &&
        typeof a.id === "string" &&
        !!a.id &&
        a.id !== OPEN_ACTION_ID &&
        typeof a.label === "string" &&
        !!a.label,
    )
    .map((a) => ({ id: a.id, label: a.label }))
    .slice(0, MAX_ACTIONS);
  return kept.length ? kept : undefined;
}

/** Keep only well-formed items of kinds that still exist — a persisted list
 *  outlives the code that wrote it. */
function sanitize(items: unknown): AppNotification[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter(
      (i): i is AppNotification =>
        !!i &&
        typeof i === "object" &&
        typeof i.id === "string" &&
        typeof i.timestamp === "string" &&
        isNotificationKind(i.kind),
    )
    .map((i) => {
      const t = i.target !== undefined && !isAppTarget(i.target) ? { ...i, target: undefined } : i;
      const a =
        t.agentType !== undefined && (typeof t.agentType !== "string" || !t.agentType)
          ? { ...t, agentType: undefined }
          : t;
      return a.actions === undefined
        ? a
        : { ...a, actions: a.resolved ? undefined : cleanActions(a.actions) };
    })
    .slice(0, MAX_ITEMS);
}

function isAppTarget(t: unknown): t is NonNullable<AppNotification["target"]> {
  if (!t || typeof t !== "object") return false;
  const r = t as Record<string, unknown>;
  return (
    r.type === "atlas-sign-in" ||
    (r.type === "agent-sign-in" && typeof r.agentType === "string" && !!r.agentType) ||
    (r.type === "chat-conversation" && typeof r.convId === "string" && !!r.convId) ||
    r.type === "app-update" ||
    (r.type === "settings" && isNotificationSettingsSection(r.section)) ||
    r.type === "config-file" ||
    (r.type === "git-panel" && typeof r.projectId === "string" && !!r.projectId)
  );
}

export const useNotificationsStore = createSelectors(
  create<NotificationsState>()(
    persist(
      (set) => ({
        items: [],
        panelOpen: false,
        actions: {
          add: (n) =>
            set((s) => ({
              items: [
                {
                  ...n,
                  actions: cleanActions(n.actions),
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
          markSessionKindRead: (sessionId, kind) =>
            set((s) => ({
              items: s.items.map((i) =>
                !i.read && i.kind === kind && i.sessionId === sessionId ? { ...i, read: true } : i,
              ),
            })),
          markKindRead: (kind, match) =>
            set((s) => ({
              items: s.items.map((i) =>
                !i.read && i.kind === kind && (!match || match(i)) ? { ...i, read: true } : i,
              ),
            })),
          markReadWhere: (match) =>
            set((s) => ({
              items: s.items.map((i) => (!i.read && match(i) ? { ...i, read: true } : i)),
            })),
          resolveWhere: (match) =>
            set((s) => ({
              items: s.items.map((i) =>
                match(i) && (!i.read || !i.resolved)
                  ? { ...i, read: true, resolved: true, actions: undefined }
                  : i,
              ),
            })),
          open: (orgId) =>
            set((s) => ({ panelOpen: true, items: markVisibleRead(s.items, orgId) })),
          close: () => set({ panelOpen: false }),
          toggle: (orgId) =>
            set((s) =>
              s.panelOpen
                ? { panelOpen: false }
                : { panelOpen: true, items: markVisibleRead(s.items, orgId) },
            ),
        },
      }),
      {
        name: "atlas-notifications",
        version: 1,
        partialize: (s) => ({ items: s.items }),
        merge: (persisted, current) => ({
          ...current,
          items: sanitize((persisted as { items?: unknown } | undefined)?.items),
        }),
      },
    ),
  ),
);
