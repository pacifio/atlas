import { useTipOnMount } from "@/features/tips/lib/use-tip-on-mount";
import { useEffect, useMemo } from "react";
import { CommsConversation } from "./comms-conversation";
import { MediaLightbox } from "./media-lightbox";
import { primeCommsMarkdown } from "./message-body";
import { CommsHome } from "./comms-home";
import { CommsNotConnected } from "./comms-not-connected";
import { CommsSkeleton } from "./comms-skeleton";
import { useCommsStore } from "../stores/comms-store";
import { comms } from "../lib/comms-api";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useAuthStore } from "@/features/auth/stores/auth-store";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { convertFileSrc } from "@tauri-apps/api/core";
import { byRecency, conversationTitle, memberName } from "../lib/derive";
import type { ChatConversation, OrgMemberProfile } from "../types";
import {
  CommsBodyView,
  CommsConnectingView,
  CommsPanelView,
  CommsSplitView,
  CommsTabsView,
  type CommsTabKind,
} from "./views/comms-panel-view";

/**
 * Team chat, a surface tab and a destination (⌘⇧C, ADR-0024).
 *
 * As a surface — the short-hand view beside a session — conversations open as
 * tabs in a bar of their own rather than replacing one another, because chat
 * here is org-scoped and someone watching #atlas-desktop while answering a DM
 * is the ordinary case, not the exception. The bar sits under the column's
 * tab strip; the window's controls are the column header's, not this panel's.
 *
 * As the destination (`split`) it is the web app's layout: the channels and
 * people as a sidebar on the left, the open conversation beside it, #general
 * until something else is picked. The two forms share one store, so a
 * conversation opened in one is the one the other shows.
 */
export function CommsPanel({ split = false }: { split?: boolean } = {}) {
  useTipOnMount("team-chat");
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
  // Fetch the markdown chunk as soon as the panel exists, so the first message
  // body never waits on it. Not done in `App.tsx` alongside the other priming:
  // that path is about the boot budget, and this panel is lazy precisely so it
  // costs nothing until someone opens chat.
  useEffect(() => {
    primeCommsMarkdown();
  }, []);

  // `signedIn` is a GUARD AND A DEP, the members-modal pattern: on a cold
  // boot `remoteId` is ready (persisted app state) long before the credential
  // is, so a fetch fired at mount rejects — and with no auth dep, nothing
  // ever refired it. That was the "Unknown DMs until ⌘⇧C twice" bug.
  useEffect(() => {
    if (remoteId && signedIn) void loadMembers(remoteId);
  }, [remoteId, signedIn, loadMembers]);

  // Self-heal a missed resync: hydrate on mount and on every reopen of the
  // socket. Safe to repeat — `mergeWindow` makes windows clobber-proof and
  // `hydrate` itself discards a snapshot that is stale or belongs to another
  // org — so the panel no longer depends on the one boot-time `comms_ready`
  // announcement having landed while we were listening.
  //
  // Only the OPENING edge of the socket re-hydrates. This effect used to run
  // on both edges, and the closing one fired at the exact moment an org
  // switch reset the store — before Rust had been retargeted — so it
  // snapshotted the OUTGOING org and wrote it wholesale over the reset.
  const socketOpen = connection.state === "open";
  useEffect(() => {
    if (connected) void actions.hydrate();
  }, [connected, actions]);
  useEffect(() => {
    if (connected && socketOpen) void actions.hydrate();
  }, [connected, socketOpen, actions]);

  // The split view always has a conversation open: #general when nothing is,
  // else the first channel, else the most recent conversation. Picked once the
  // list is here, and again if the open one goes away (left, deleted).
  const defaultConvId = useMemo(() => {
    if (!split) return null;
    const channels = conversations.filter((c) => c.kind === "channel");
    return (
      channels.find((c) => c.name === "general")?.id ??
      [...channels].sort(byRecency)[0]?.id ??
      [...conversations].sort(byRecency)[0]?.id ??
      null
    );
  }, [split, conversations]);
  useEffect(() => {
    if (split && !activeConv && defaultConvId) actions.openConversation(defaultConvId);
  }, [split, activeConv, defaultConvId, actions]);

  useEffect(() => {
    const roster = remoteId ? rosterByOrg[remoteId] : undefined;
    if (!roster?.members) return;
    const next = roster.members.map((m) => ({
      // `id` on a membership row is the membership; `userId` is the person,
      // and the person is what a message's `author_id` names.
      id: m.userId,
      name: memberName(m.name, m.email),
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
      <CommsPanelView>
        <CommsNotConnected org={activeOrg} />
      </CommsPanelView>
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
      <CommsPanelView>
        {terminal ? (
          <CommsConnectingView
            state={connection.state}
            reason={connection.reason}
            onRetry={() => void comms.reconnect().catch(() => {})}
          />
        ) : (
          <CommsSkeleton />
        )}
      </CommsPanelView>
    );
  }

  if (split) {
    return (
      <CommsPanelView overlay={<MediaLightbox />}>
        <CommsSplitView list={<CommsHome sidebar activeConvId={activeConv?.id ?? null} />}>
          {activeConv ? (
            // Keyed so each conversation mounts fresh.
            <div key={activeConv.id} className="flex min-w-0 flex-1">
              <CommsConversation conv={activeConv} showBack={false} />
            </div>
          ) : null}
        </CommsSplitView>
      </CommsPanelView>
    );
  }

  return (
    <CommsPanelView
      // Only with two or more open: one view needs no tabs of its own under
      // the column's "Team chat" tab, and a conversation's header already
      // leads back home. ⌘-click a conversation to open a second.
      bar={
        tabs.length > 1 && (
          <CommsTabsView
            tabs={tabs.map((tab) => {
              const conv = tab.convId ? (convById.get(tab.convId) ?? null) : null;
              const read = tab.convId ? readBy.get(tab.convId) : undefined;
              return {
                id: tab.id,
                title: tabTitle(conv, members, me),
                kind: tabKind(conv),
                unread: Number(read?.unread ?? 0),
                mentions: Number(read?.mentions ?? 0),
              };
            })}
            activeId={activeTabId}
            onSelect={(id) => actions.setActiveTab(id)}
            onClose={(id) => actions.closeTab(id)}
            onNew={() => actions.newTab()}
          />
        )
      }
      overlay={<MediaLightbox />}
    >
      <CommsBodyView>
        {activeConv ? (
          // Keyed so each conversation mounts fresh.
          <div key={activeConv.id} className="flex min-w-0 flex-1">
            <CommsConversation conv={activeConv} />
          </div>
        ) : (
          <CommsHome />
        )}
      </CommsBodyView>
    </CommsPanelView>
  );
}

/** A tab's label. `null` = this view is at home. */
function tabTitle(
  conv: ChatConversation | null,
  members: Map<string, OrgMemberProfile>,
  me: string,
): string {
  if (conv === null) return "Chats";
  return conv.kind === "channel" ? (conv.name ?? "") : conversationTitle(conv, members, me);
}

function tabKind(conv: ChatConversation | null): CommsTabKind {
  if (conv === null) return "home";
  if (conv.kind === "channel") return conv.visibility === "private" ? "private" : "channel";
  return conv.kind === "group_dm" ? "group" : "dm";
}
