import { useEffect, useMemo } from "react";
import { Hash, Loader2, Lock, MessageCircle, MessagesSquare, Plus, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CommsConversation } from "./comms-conversation";
import { CommsHome } from "./comms-home";
import { CommsNotConnected } from "./comms-not-connected";
import { CommsSkeleton } from "./comms-skeleton";
import { useCommsStore } from "../stores/comms-store";
import { comms, type ConnReason, type ConnectionState } from "../lib/comms-api";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { convertFileSrc } from "@tauri-apps/api/core";
import { conversationTitle } from "../lib/derive";
import type { ChatConversation, OrgMemberProfile } from "../types";

/**
 * Team chat, in the right panel slot (⌘⇧C).
 *
 * Conversations open as TABS in the header rather than replacing one another,
 * because chat here is org-scoped and someone watching #atlas-desktop while
 * answering a DM is the ordinary case, not the exception. The tab strip mirrors
 * the source-control panel's 29px header band so the two occupants of the slot
 * are visually interchangeable.
 */
export function CommsPanel() {
  const conversations = useCommsStore.use.conversations();
  const reads = useCommsStore.use.reads();
  const memberList = useCommsStore.use.members();
  const me = useCommsStore.use.me();
  const tabs = useCommsStore.use.tabs();
  const activeTabId = useCommsStore.use.activeTabId();
  const connection = useCommsStore.use.connection();
  const actions = useCommsStore.use.actions();

  const members = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList]);
  const convById = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);
  const readBy = useMemo(() => new Map(reads.map((r) => [r.conv_id, r])), [reads]);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  // A convId whose conversation vanished (left the channel, org data moved)
  // degrades to the home view rather than a dead pane.
  const activeConv = activeTab?.convId ? (convById.get(activeTab.convId) ?? null) : null;

  // Chat is org-scoped and every route names a *server* org id, so a local-only
  // organisation has nothing to talk to. There is no `useActiveOrg` helper —
  // the find is the convention across the app.
  const organisations = useOrgStore.use.organisations();
  const activeOrganisationId = useOrgStore.use.activeOrganisationId();
  const activeOrg = organisations.find((o) => o.id === activeOrganisationId) ?? null;
  const connected = !!(activeOrg?.syncEnabled && activeOrg?.remoteId);

  // Chat sends user ids and nothing else, so every name, avatar and resolved
  // mention comes from the org roster. It is keyed by the SERVER org id — and
  // the SOCKET's org wins over the locally-persisted one: a Rust-driven
  // retarget (boot reconciliation fixing a clobbered active org) changes
  // `connection.orgId` without touching the org store, and keying off the
  // stale id kept the previous org's names on screen forever.
  const remoteId = connection.orgId || activeOrg?.remoteId;
  const signedIn = useAuthStore.use.snapshot().status === "signed-in";
  const rosterByOrg = useMembersStore.use.byOrg();
  const { load: loadMembers } = useMembersStore.use.actions();
  // `signedIn` is a GUARD AND A DEP, the members-modal pattern: on a cold
  // boot `remoteId` is ready (persisted app state) long before the credential
  // is, so a fetch fired at mount rejects — and with no auth dep, nothing
  // ever refired it. That was the "Unknown DMs until ⌘⇧C twice" bug.
  useEffect(() => {
    if (remoteId && signedIn) void loadMembers(remoteId);
  }, [remoteId, signedIn, loadMembers]);

  // Self-heal a missed resync: hydrate on mount and on every reopen of the
  // socket. Safe to repeat, and `mergeWindow` makes it clobber-proof — the
  // panel no longer depends on the one boot-time `comms_ready` announcement
  // having landed while we were listening.
  const socketOpen = connection.state === "open";
  useEffect(() => {
    if (connected) void actions.hydrate();
  }, [connected, socketOpen, actions]);

  useEffect(() => {
    const roster = remoteId ? rosterByOrg[remoteId] : undefined;
    if (!roster?.members) return;
    const next = roster.members.map((m) => ({
      // `id` on a membership row is the membership; `userId` is the person,
      // and the person is what a message's `author_id` names.
      id: m.userId,
      name: m.name,
      email: m.email,
      image: m.avatarPath ? convertFileSrc(m.avatarPath) : null,
      role: m.role ?? ("member" as const),
    }));
    // `rosterByOrg` gets a new identity on every members-store patch (including
    // its own `loading` flip), and an unchanged roster pushed through here used
    // to give `members` a new identity → the members Map rebuilt → every
    // message body's memo died and re-parsed. Only a real change may write.
    const current = useCommsStore.getState().members;
    const same =
      current.length === next.length &&
      next.every(
        (m, i) =>
          current[i].id === m.id &&
          current[i].name === m.name &&
          current[i].email === m.email &&
          current[i].image === m.image &&
          current[i].role === m.role,
      );
    if (!same) actions.setMembers(next);
  }, [remoteId, rosterByOrg, actions]);

  if (!connected) {
    // No header band here: there are no tabs to hold and nothing to title, and
    // an empty 29px strip labelled "Team Chat" only repeats what the panel
    // already is. The placeholder gets the whole surface.
    return (
      <div className="atlas-vibrant-panel flex h-full flex-col bg-[var(--comms-outer)] pt-1.5">
        <CommsSurface>
          <CommsNotConnected org={activeOrg} />
        </CommsSurface>
      </div>
    );
  }

  // Between "org is synced" and "data is here" there is a real window — token
  // mint plus TLS plus hello takes seconds on a cold launch — and an empty
  // sidebar in that window reads as broken, not busy. Only shown while we hold
  // nothing: once the sqlite snapshot or hello has painted, reconnects happen
  // behind the data. The full chrome renders around the skeleton — header
  // band, surface card — so connecting → loaded swaps content in place
  // instead of popping a 38px header into existence and shifting the card.
  if (conversations.length === 0 && connection.state !== "open") {
    const terminal = connection.state === "unavailable";
    return (
      <div className="atlas-vibrant-panel flex h-full flex-col bg-[var(--comms-outer)]">
        <div className="flex h-[38px] shrink-0 items-center pl-2">
          <div className="flex h-[26px] items-center gap-1.5 rounded-lg bg-white/[0.07] pl-2.5 pr-2.5 text-[11.5px] font-medium text-text-primary select-none">
            <MessagesSquare size={11} className="shrink-0 opacity-70" />
            Chats
          </div>
        </div>
        <CommsSurface>
          {terminal ? (
            <CommsConnecting
              state={connection.state}
              reason={connection.reason}
              onRetry={() => void comms.reconnect().catch(() => {})}
            />
          ) : (
            <CommsSkeleton />
          )}
        </CommsSurface>
      </div>
    );
  }

  return (
    <div className="atlas-vibrant-panel flex h-full flex-col bg-[var(--comms-outer)]">
      {/* The header lives on the BACKDROP, not the card — that separation is
          the whole depth trick. Taller than the old 29px band so the tabs
          breathe like the reference. */}
      <div className="flex h-[38px] shrink-0 items-center gap-1 pl-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto hide-scrollbar"
          // A gradient overlay in the backdrop colour never quite matched it —
          // the vibrant grain composites on top of the token, so the patch
          // read as its own rectangle. A mask fades the CONTENT instead, and
          // whatever is behind it shows through exactly.
          style={{
            maskImage: "linear-gradient(to right, black, black calc(100% - 28px), transparent)",
            WebkitMaskImage:
              "linear-gradient(to right, black, black calc(100% - 28px), transparent)",
          }}
        >
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              conv={tab.convId ? (convById.get(tab.convId) ?? null) : null}
              members={members}
              me={me}
              active={tab.id === activeTabId}
              read={tab.convId ? readBy.get(tab.convId) : undefined}
              onSelect={() => actions.setActiveTab(tab.id)}
              onClose={() => actions.closeTab(tab.id)}
            />
          ))}
        </div>

        {/* The workspace sidebar's add-project button, verbatim. */}
        <div className="flex shrink-0 items-center pr-1.5">
          <button
            type="button"
            title="New tab"
            onClick={() => actions.newTab()}
            className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--border-default)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] outline-none cursor-pointer"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* `overflow-hidden` so a view can never paint outside the panel, and the
          transition is OPACITY ONLY. A transform here was the bug: this panel
          carries `atlas-vibrant-panel`, whose grain overlay blends with
          `mix-blend-mode: soft-light`, and translating a descendant across it
          made WKWebView re-composite the blended layer every frame — which it
          did wrong, flashing black and clipping the view mid-slide. The house
          rule from the notification panel is that blur and animation belong on
          ONE element; the honest way to keep a transition here is to move no
          geometry at all. */}
      <CommsSurface>
        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {activeConv ? (
            // Keyed so navigating between conversations re-runs the fade.
            <div key={activeConv.id} className="flex min-w-0 flex-1 animate-fade-in">
              <CommsConversation conv={activeConv} />
            </div>
          ) : (
            <CommsHome />
          )}
        </div>
      </CommsSurface>
    </div>
  );
}

/**
 * The interface card: a rounded near-black surface floating on the panel's
 * warm backdrop, inset on the sides and bottom. The depth is the point — a
 * hairline ring plus a soft drop shadow, no blur and no transform, so it
 * lives safely inside `atlas-vibrant-panel`.
 */
function CommsSurface({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mx-1.5 mb-1.5 flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] bg-[var(--comms-surface)]"
      style={{
        // Pure black on #0f0f0f leaves a drop shadow almost nothing to darken,
        // so the hairline ring carries the edge; the shadow just softens it.
        boxShadow: "0 0 0 1px rgba(255,255,255,0.08), 0 10px 28px rgba(0,0,0,0.6)",
      }}
    >
      {children}
    </div>
  );
}

function TabButton({
  conv,
  members,
  me,
  active,
  read,
  onSelect,
  onClose,
}: {
  /** `null` = this view is at home. */
  conv: ChatConversation | null;
  members: Map<string, OrgMemberProfile>;
  me: string;
  active: boolean;
  read: { unread: number; mentions: number } | undefined;
  onSelect: () => void;
  onClose: () => void;
}) {
  const label =
    conv === null
      ? "Chats"
      : conv.kind === "channel"
        ? conv.name
        : conversationTitle(conv, members, me);
  const unread = Number(read?.unread ?? 0);
  const mentions = Number(read?.mentions ?? 0);

  const icon =
    conv === null ? (
      <MessagesSquare size={11} className="shrink-0 opacity-70" />
    ) : conv.kind === "channel" ? (
      conv.visibility === "private" ? (
        <Lock size={10} className="shrink-0 opacity-70" />
      ) : (
        <Hash size={11} className="shrink-0 opacity-70" />
      )
    ) : conv.kind === "group_dm" ? (
      <Users size={11} className="shrink-0 opacity-70" />
    ) : (
      <MessageCircle size={11} className="shrink-0 opacity-70" />
    );

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
        "group/tab relative flex h-[26px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg pl-2.5 text-[11.5px] font-medium select-none",
        "transition-[padding-right,background-color,color] duration-150",
        "pr-2.5 hover:pr-6",
        active
          ? "bg-white/[0.07] text-text-primary"
          : "text-text-tertiary hover:bg-white/[0.04] hover:text-text-secondary",
      )}
    >
      {icon}
      <span className="max-w-[110px] truncate">{label}</span>

      {mentions > 0 ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--comms-mention-text)]" />
      ) : unread > 0 ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--comms-unread)]" />
      ) : null}

      <button
        type="button"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className={cn(
          "absolute right-1 top-1/2 -translate-y-1/2",
          "inline-flex h-4 w-4 items-center justify-center rounded-full",
          "text-text-tertiary opacity-0 group-hover/tab:opacity-100",
          "transition-opacity duration-150 hover:bg-[#ffffff22] hover:text-text-primary cursor-pointer",
        )}
      >
        <X size={10} strokeWidth={2.2} />
      </button>
    </div>
  );
}

function CommsConnecting({
  state,
  reason,
  onRetry,
}: {
  state: ConnectionState;
  reason: ConnReason | null;
  onRetry: () => void;
}) {
  // `unavailable` is terminal — the supervisor stopped because retrying cannot
  // help — so it gets an explanation and a manual retry instead of a spinner
  // that would promise progress nobody is making.
  if (state === "unavailable") {
    return (
      <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <div className="text-[12px] font-medium text-text-primary">Chat is unavailable</div>
        <p className="max-w-[220px] text-[11px] leading-relaxed text-text-secondary">
          {reason === "not_a_member"
            ? "Your account isn't a member of this organisation's chat."
            : reason === "evicted"
              ? "You were removed from this organisation."
              : "Couldn't authenticate with the chat service."}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 flex h-[26px] items-center rounded-md border border-border-default bg-bg-hover px-3 text-[11px] font-medium text-text-primary transition-colors hover:bg-bg-active cursor-pointer"
        >
          Try again
        </button>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
      <Loader2 size={16} className="animate-spin text-text-tertiary" />
      <div className="text-[11.5px] text-text-secondary">
        {state === "backoff" ? "Reconnecting…" : "Connecting to team chat…"}
      </div>
    </div>
  );
}
