import { useEffect, useMemo } from "react";
import { Hash, House, Loader2, Lock, Plus, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CommsAvatar } from "./comms-avatar";
import { CommsConversation } from "./comms-conversation";
import { CommsHome } from "./comms-home";
import { CommsNotConnected } from "./comms-not-connected";
import { useCommsStore } from "../stores/comms-store";
import { comms, type ConnReason, type ConnectionState } from "../lib/comms-api";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { convertFileSrc } from "@tauri-apps/api/core";
import { conversationTitle, dmCounterpart } from "../lib/derive";
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
  const online = useCommsStore.use.online();
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
  // mention comes from the org roster. It is keyed by the SERVER org id.
  const remoteId = activeOrg?.remoteId;
  const rosterByOrg = useMembersStore.use.byOrg();
  const { load: loadMembers } = useMembersStore.use.actions();
  useEffect(() => {
    if (remoteId) void loadMembers(remoteId);
  }, [remoteId, loadMembers]);
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
      <div className="atlas-vibrant-panel flex h-full flex-col bg-[var(--panel-bg-2)]">
        <CommsNotConnected org={activeOrg} />
      </div>
    );
  }

  // Between "org is synced" and "data is here" there is a real window — token
  // mint plus TLS plus hello takes seconds on a cold launch — and an empty
  // sidebar in that window reads as broken, not busy. Only shown while we hold
  // nothing: once the sqlite snapshot or hello has painted, reconnects happen
  // behind the data.
  if (conversations.length === 0 && connection.state !== "open") {
    return (
      <div className="atlas-vibrant-panel flex h-full flex-col bg-[var(--panel-bg-2)]">
        <CommsConnecting
          state={connection.state}
          reason={connection.reason}
          onRetry={() => void comms.reconnect().catch(() => {})}
        />
      </div>
    );
  }

  return (
    <div className="atlas-vibrant-panel flex h-full flex-col bg-[var(--panel-bg-2)]">
      <div className="flex h-[29px] shrink-0 items-center gap-0.5 border-b border-border-default px-1">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto hide-scrollbar">
          {tabs.map((tab) => (
            <TabButton
              key={tab.id}
              conv={tab.convId ? (convById.get(tab.convId) ?? null) : null}
              members={members}
              online={online}
              me={me}
              active={tab.id === activeTabId}
              read={tab.convId ? readBy.get(tab.convId) : undefined}
              onSelect={() => actions.setActiveTab(tab.id)}
              onClose={() => actions.closeTab(tab.id)}
            />
          ))}
        </div>

        <button
          type="button"
          title="New tab"
          onClick={() => actions.newTab()}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary cursor-pointer"
        >
          <Plus size={13} />
        </button>
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
    </div>
  );
}

function TabButton({
  conv,
  members,
  online,
  me,
  active,
  read,
  onSelect,
  onClose,
}: {
  /** `null` = this view is at home. */
  conv: ChatConversation | null;
  members: Map<string, OrgMemberProfile>;
  online: string[];
  me: string;
  active: boolean;
  read: { unread: number; mentions: number } | undefined;
  onSelect: () => void;
  onClose: () => void;
}) {
  const counterpart = conv ? dmCounterpart(conv, members, me) : null;
  const label =
    conv === null
      ? "Chats"
      : conv.kind === "channel"
        ? conv.name
        : conversationTitle(conv, members, me);
  const unread = Number(read?.unread ?? 0);
  const mentions = Number(read?.mentions ?? 0);

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
        "group/tab relative flex h-[22px] shrink-0 cursor-pointer items-center gap-1 rounded pl-1.5 text-[11px] font-medium select-none",
        // The close affordance is absolutely positioned, so the tab makes room
        // for it by growing its right padding on hover — the same animation the
        // centre-panel tab strip uses, so both tab bars behave identically.
        "transition-[padding-right,background-color,color] duration-150",
        "pr-1.5 hover:pr-6",
        active
          ? "bg-bg-selected text-text-primary"
          : "text-text-tertiary hover:bg-bg-hover hover:text-text-secondary",
      )}
    >
      {conv === null ? (
        <House size={11} className="shrink-0 opacity-70" />
      ) : conv.kind === "channel" ? (
        conv.visibility === "private" ? (
          <Lock size={10} className="shrink-0 opacity-70" />
        ) : (
          <Hash size={11} className="shrink-0 opacity-70" />
        )
      ) : conv.kind === "group_dm" ? (
        <Users size={11} className="shrink-0 opacity-70" />
      ) : (
        <CommsAvatar
          member={counterpart}
          size={13}
          online={counterpart ? online.includes(counterpart.id) : undefined}
        />
      )}
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
