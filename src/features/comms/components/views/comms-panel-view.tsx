import type { ReactNode } from "react";
import { Hash, Lock, MessageCircle, MessagesSquare, Plus, Users, X } from "lucide-react";
import { Button, EmptyState, Hint, IconButton, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";
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
 * Hand-built rather than the package's `TabStrip`: here every tab is its own
 * Tab stop with a Tab-reachable close button, and `TabStrip`'s roving focus
 * and middle-click close are behaviour changes still awaiting review
 * (ATL-718), so adopting it waits on that sign-off.
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
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pl-1.5">
      <div
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto hide-scrollbar"
        // A gradient overlay in the backdrop colour never quite matched it —
        // the vibrant grain composites on top of the token, so the patch
        // read as its own rectangle. A mask fades the CONTENT instead, and
        // whatever is behind it shows through exactly.
        style={{
          maskImage: "linear-gradient(to right, black, black calc(100% - 28px), transparent)",
          WebkitMaskImage: "linear-gradient(to right, black, black calc(100% - 28px), transparent)",
        }}
      >
        {tabs.map((tab) => (
          <CommsTab
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onSelect={() => onSelect(tab.id)}
            onClose={() => onClose(tab.id)}
          />
        ))}
      </div>

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

function CommsTab({
  tab,
  active,
  onSelect,
  onClose,
}: {
  tab: CommsTabItem;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const Glyph = TAB_ICON[tab.kind];
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group/tab relative flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg pl-2.5 pr-6 text-sm font-medium select-none",
        "transition-[background-color,color] duration-fast ease-out-strong",
        active
          ? "bg-element-selected text-foreground"
          : "text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground",
      )}
    >
      <Glyph size={tab.kind === "private" ? 10 : 11} className="shrink-0 opacity-70" />
      <span className="max-w-[110px] truncate">{tab.title}</span>

      {tab.mentions > 0 ? (
        <span className="size-1.5 shrink-0 rounded-full bg-foreground" />
      ) : tab.unread > 0 ? (
        <span className="size-1.5 shrink-0 rounded-full bg-success" />
      ) : null}

      <Hint label="Close tab">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            "absolute right-1 top-1/2 -translate-y-1/2",
            "inline-flex size-4 items-center justify-center rounded-full",
            "text-muted-foreground opacity-0 scale-90 group-hover/tab:opacity-100 group-hover/tab:scale-100 focus-visible:opacity-100 focus-visible:scale-100",
            "transition-[opacity,scale,background-color,color] duration-fast ease-out-strong hover:bg-[var(--element-emphasis)] hover:text-foreground cursor-pointer",
          )}
        >
          <X size={10} strokeWidth={2.2} />
        </button>
      </Hint>
    </div>
  );
}

/**
 * The body while the panel holds nothing and the socket is not open.
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
