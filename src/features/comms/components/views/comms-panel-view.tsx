import { useMemo, type ReactNode } from "react";
import { Hash, Lock, MessageCircle, MessagesSquare, Plus, Users } from "lucide-react";
import {
  Button,
  EmptyState,
  Hint,
  Icon,
  IconButton,
  Spinner,
  TabStrip,
  type TabStripItem,
} from "@tryatlas/design";
import type { LucideIcon } from "lucide-react";

/**
 * Team chat's frame: an optional bar of conversation tabs, then the surface
 * the body sits on, then whatever overlays it (the media lightbox). Every
 * state of the panel — not connected, loading, unavailable, home, a
 * conversation, the split view — renders inside this one frame, so moving
 * between them swaps content in place rather than shifting the chrome.
 */
export function CommsPanelView({
  bar,
  children,
  overlay,
}: {
  /** The tab bar, or nothing: no tabs to hold means no band at all. */
  bar?: ReactNode;
  children: ReactNode;
  overlay?: ReactNode;
}) {
  return (
    <div data-view="comms-panel" className="flex h-full flex-col bg-background">
      {bar}
      {/* `overflow-hidden` so a view can never paint outside the panel. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">{children}</div>
      {overlay}
    </div>
  );
}

/**
 * The destination's layout: the channels and people as a sidebar on the left,
 * the open conversation beside it. A rule along the top, under the window's
 * bar, so the view starts where the bar ends.
 */
export function CommsSplitView({ list, children }: { list: ReactNode; children: ReactNode }) {
  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden border-t border-border">
      <aside
        aria-label="Channels and people"
        className="flex w-72 shrink-0 flex-col border-r border-border"
      >
        {list}
      </aside>
      <div className="flex min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** The body column a single view (home or a conversation) fills. */
export function CommsBodyView({ children }: { children: ReactNode }) {
  return <div className="relative flex min-h-0 flex-1 overflow-hidden">{children}</div>;
}

export type CommsTabKind = "home" | "channel" | "private" | "group" | "dm";

export interface CommsTabItem {
  id: string;
  title: string;
  kind: CommsTabKind;
  unread: number;
  mentions: number;
}

const TAB_ICON: Record<CommsTabKind, LucideIcon> = {
  home: MessagesSquare,
  channel: Hash,
  private: Lock,
  group: Users,
  dm: MessageCircle,
};

/**
 * The open conversations, as tabs, under the column's own tab strip.
 *
 * The package's `TabStrip`, with its defaults: one Tab stop (the active tab),
 * ←/→ wrap, Home/End jump, Enter or Space opens, Delete and middle-click close,
 * and the × named "Close {title}". The `+` sits outside the strip so it stays
 * at the right edge however few tabs there are.
 */
export function CommsTabsView({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
}: {
  tabs: CommsTabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  const items = useMemo<TabStripItem[]>(
    () =>
      tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        closable: true,
        icon: <TabGlyph tab={tab} />,
      })),
    [tabs],
  );
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pl-1.5">
      <TabStrip
        aria-label="Chats"
        items={items}
        activeId={activeId}
        onSelect={onSelect}
        onClose={onClose}
        className="flex-1"
      />

      <div className="flex shrink-0 items-center pr-1.5">
        <Hint label="New tab">
          <IconButton
            icon={Plus}
            label="New tab"
            size="sm"
            shape="round"
            variant="outline"
            onClick={onNew}
          />
        </Hint>
      </div>
    </div>
  );
}

/** A tab's kind glyph, with the unread dot on its corner: a mention lights it
 *  in the foreground, plain unread in the success tone. */
function TabGlyph({ tab }: { tab: CommsTabItem }) {
  return (
    <span className="relative flex">
      <span className="flex opacity-70">
        <Icon icon={TAB_ICON[tab.kind]} size="sm" />
      </span>
      {tab.mentions > 0 ? (
        <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-foreground" />
      ) : tab.unread > 0 ? (
        <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-success" />
      ) : null}
    </span>
  );
}

/**
 * The body while the panel holds nothing and the socket is not open. The
 * panel renders it only for `unavailable` today (the other states show the
 * skeleton); the spinner branch is kept for a caller that wants it.
 *
 * `unavailable` is terminal — the supervisor stopped because retrying cannot
 * help — so it gets an explanation and a manual retry instead of a spinner
 * that would promise progress nobody is making.
 */
export function CommsConnectingView({
  state,
  reason,
  onRetry,
}: {
  // `ConnectionState` and `ConnReason`, restated: a view may not import the
  // IPC module, not even for its types (view-purity-contract).
  state: "disconnected" | "connecting" | "open" | "backoff" | "unavailable";
  reason: "auth" | "not_a_member" | "evicted" | "offline" | null;
  onRetry: () => void;
}) {
  if (state === "unavailable") {
    return (
      <EmptyState
        className="min-w-0 flex-1"
        title="Chat is unavailable"
        description={
          reason === "not_a_member"
            ? "Your account isn't a member of this organization's chat."
            : reason === "evicted"
              ? "You were removed from this organization."
              : "Couldn't authenticate with the chat service."
        }
        action={
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <Spinner label="" />
      <div className="text-sm text-secondary-foreground">
        {state === "backoff" ? "Reconnecting…" : "Connecting to team chat…"}
      </div>
    </div>
  );
}
