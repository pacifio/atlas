import { useMemo, useState } from "react";
import { ChevronRight, Hash, Loader2, Lock, MessagesSquare, Search, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { comms } from "../lib/comms-api";
import { CommsAvatar } from "./comms-avatar";
import { byRecency, conversationTitle } from "../lib/derive";
import { useCommsStore } from "../stores/comms-store";
import { useMembersStore } from "@/features/organisations/stores/members-store";
import { CreateChannelMenu } from "./create-channel-menu";
import { NewDmMenu } from "./new-dm-menu";
import type { LucideIcon } from "lucide-react";
import type { ChatConversation, ChatReadState, OrgMemberProfile } from "../types";

/**
 * The home view of a chat tab: every channel, every direct conversation, and
 * every colleague you could start one with — full width, Slack's information
 * architecture in Atlas's clothes.
 *
 * "Contacts" and "conversations" are deliberately one Direct-messages section:
 * a person you have a DM with and a person you could DM are the same kind of
 * row to a reader, so existing DMs come first (they have activity) and the
 * rest of the roster follows. Clicking a colleague without a DM creates one —
 * the server makes that idempotent, so it is "open" in every case that
 * matters.
 */
export function CommsHome() {
  const conversations = useCommsStore.use.conversations();
  const discoverable = useCommsStore.use.discoverable();
  const reads = useCommsStore.use.reads();
  const memberList = useCommsStore.use.members();
  // The DM/contact sections are unreadable without the roster (titles resolve
  // to "Unknown", contacts are simply absent), so while it is still on its
  // way the sections show placeholder rows rather than degraded ones.
  const rosterOrgId = useCommsStore((s) => s.connection.orgId);
  const rosterLoading = useMembersStore((s) =>
    rosterOrgId ? (s.byOrg[rosterOrgId]?.loading ?? false) : false,
  );
  const rosterPending = memberList.length === 0 && rosterLoading;
  const online = useCommsStore.use.online();
  const me = useCommsStore.use.me();
  const actions = useCommsStore.use.actions();
  // ⌘-click (Ctrl elsewhere) opens a conversation in a tab of its own, the
  // way a browser link does; a plain click navigates this one.
  const open = (convId: string, e: React.MouseEvent) =>
    e.metaKey || e.ctrlKey
      ? actions.openConversationInNewTab(convId)
      : actions.openConversation(convId);

  const [query, setQuery] = useState("");
  const [showDiscover, setShowDiscover] = useState(false);
  /** The member whose DM is being created, for the row's spinner. */
  const [startingDm, setStartingDm] = useState<string | null>(null);

  const members = useMemo(() => new Map(memberList.map((m) => [m.id, m])), [memberList]);
  const readBy = useMemo(() => new Map(reads.map((r) => [r.conv_id, r])), [reads]);

  const q = query.trim().toLowerCase();
  const matches = (text: string | null | undefined) => !q || (text ?? "").toLowerCase().includes(q);

  const channels = useMemo(
    () => conversations.filter((c) => c.kind === "channel" && matches(c.name)).sort(byRecency),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversations, q],
  );
  const directs = useMemo(
    () =>
      conversations
        .filter((c) => c.kind !== "channel" && matches(conversationTitle(c, members, me)))
        .sort(byRecency),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversations, members, me, q],
  );
  // Group conversations and 1:1s are different things wearing the same row —
  // a group has a member count where a person has an address — so they are
  // rendered as two runs with a rule between them rather than one blended list.
  const groupDms = useMemo(() => directs.filter((c) => c.kind === "group_dm"), [directs]);
  const oneToOnes = useMemo(() => directs.filter((c) => c.kind !== "group_dm"), [directs]);

  /** Colleagues with no 1:1 DM yet — the "you could talk to" tail. */
  const contacts = useMemo(() => {
    const haveDm = new Set(
      conversations
        .filter((c) => c.kind === "dm")
        .flatMap((c) => (c.member_ids ?? []).filter((id) => id !== me)),
    );
    return memberList
      .filter((m) => m.id !== me && !haveDm.has(m.id))
      .filter((m) => matches(m.name) || matches(m.email))
      .sort((a, b) => a.name.localeCompare(b.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, memberList, me, q]);

  const discover = useMemo(
    () => discoverable.filter((c) => matches(c.name)).sort(byRecency),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [discoverable, q],
  );

  const startDm = async (userId: string) => {
    if (startingDm) return;
    setStartingDm(userId);
    try {
      // Idempotent server-side: 200 = opened the existing one, 201 = created.
      const result = await comms.createDm(userId);
      actions.adoptConversation(result.conversation);
      actions.openConversation(result.conversation.id);
    } catch (e) {
      console.warn("comms: DM create failed:", userId, e);
    } finally {
      setStartingDm(null);
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col animate-fade-in">
      <div className="shrink-0 px-2 pt-2 pb-1">
        {/* Radius matches the surface card it sits in (CommsSurface's
            `rounded-xl`) — a tighter corner read as a different family. */}
        <div className="flex items-center gap-1.5 rounded-xl border border-border bg-panel-input px-2.5 py-[5px] focus-within:border-border-strong">
          <Search size={12} className="shrink-0 text-disabled" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a channel or person…"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-disabled"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar pb-3">
        <SectionLabel label="Channels" icon={Hash} action={<CreateChannelMenu />} />
        {channels.map((c) => (
          <ChannelRow key={c.id} conv={c} read={readBy.get(c.id)} onOpen={(e) => open(c.id, e)} />
        ))}
        {channels.length === 0 && (
          <EmptyHint text={q ? "No matching channels." : "No channels yet."} />
        )}

        <SectionLabel label="Direct messages" icon={MessagesSquare} action={<NewDmMenu />} />
        {rosterPending &&
          [0, 1, 2].map((i) => (
            <div key={`sk${i}`} className="flex items-center gap-2 py-[5px] pl-3.5 pr-2.5">
              {/* Mirrors DirectRow exactly — same icon slot, same avatar size,
                  one line — so the roster landing does not shift the list. */}
              <RowIcon>
                <div className="h-[22px] w-[22px] shrink-0 rounded-full bg-[var(--card)] opacity-50 atlas-marker-running" />
              </RowIcon>
              <div
                className="h-[9px] rounded bg-[var(--card)] opacity-50 atlas-marker-running"
                style={{ width: 88 + ((i * 37) % 60) }}
              />
            </div>
          ))}
        {!rosterPending &&
          groupDms.map((c) => (
            <DirectRow
              key={c.id}
              conv={c}
              read={readBy.get(c.id)}
              members={members}
              online={online}
              me={me}
              onOpen={(e) => open(c.id, e)}
            />
          ))}
        {!rosterPending && groupDms.length > 0 && (oneToOnes.length > 0 || contacts.length > 0) && (
          <RowDivider />
        )}
        {!rosterPending &&
          oneToOnes.map((c) => (
            <DirectRow
              key={c.id}
              conv={c}
              read={readBy.get(c.id)}
              members={members}
              online={online}
              me={me}
              onOpen={(e) => open(c.id, e)}
            />
          ))}
        {!rosterPending &&
          contacts.map((m) => (
            <ContactRow
              key={m.id}
              member={m}
              online={online.includes(m.id)}
              starting={startingDm === m.id}
              onStart={() => void startDm(m.id)}
            />
          ))}
        {!rosterPending && directs.length === 0 && contacts.length === 0 && (
          <EmptyHint text={q ? "Nobody matches." : "Nobody else is here yet."} />
        )}

        {discover.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowDiscover((v) => !v)}
              className="mt-2 flex w-full items-center gap-1.5 px-3 pb-1.5 pt-3.5 text-2xs font-semibold uppercase tracking-[0.06em] text-secondary-foreground transition-colors hover:text-foreground cursor-pointer"
            >
              <ChevronRight
                size={10}
                className={cn("transition-transform", showDiscover && "rotate-90")}
              />
              Discover
              <span className="ml-auto tabular-nums normal-case">{discover.length}</span>
            </button>
            {showDiscover &&
              discover.map((c) => (
                <div
                  key={c.id}
                  className="group/disc flex items-center gap-2 py-[5px] pl-3.5 pr-2.5 text-muted-foreground"
                >
                  <RowIcon>
                    <Hash size={13} className="opacity-60" />
                  </RowIcon>
                  <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                  {/* Only public channels are self-serve joinable; a private one
                      answers 404, so no button is offered for it at all. */}
                  <button
                    type="button"
                    onClick={() => actions.joinChannel(c.id)}
                    className="shrink-0 rounded px-1.5 py-px text-xs font-medium text-secondary-foreground opacity-0 transition-opacity hover:bg-element-hover hover:text-foreground group-hover/disc:opacity-100 cursor-pointer"
                  >
                    Join
                  </button>
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * A section heading, icon first.
 *
 * The icon sits at the panel's own inset while every row below is indented past
 * it — that offset is what makes the list read as "these belong to that", which
 * a bare uppercase label could not do on its own.
 */
function SectionLabel({
  label,
  icon: Icon,
  action,
}: {
  label: string;
  icon: LucideIcon;
  /** Right-aligned control — the section's `+` menus live here. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3.5 text-2xs font-semibold uppercase tracking-[0.06em] text-secondary-foreground">
      <Icon size={12} className="shrink-0" />
      {label}
      {action && <span className="ml-auto flex items-center">{action}</span>}
    </div>
  );
}

/**
 * Every row leads with an icon in a fixed-width slot — a channel's `#`, a
 * person's avatar, a group's glyph — so labels start at the same x whatever the
 * row is. Without it the `#` (13px) and an avatar (26px) put their text in two
 * different columns, which is what made the sections look unrelated.
 */
function RowIcon({ children }: { children: React.ReactNode }) {
  return <span className="flex w-7 shrink-0 items-center justify-center">{children}</span>;
}

/** A hairline between two runs of rows. Inset to the row text column so it
 *  reads as a separator inside the section, not the end of it. */
function RowDivider() {
  return (
    <div className="py-1 pl-3.5 pr-2.5">
      <div className="h-px bg-border-subtle" />
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <div className="py-1 pl-[50px] pr-2.5 text-xs text-muted-foreground">{text}</div>;
}

function ChannelRow({
  conv,
  read,
  onOpen,
}: {
  conv: ChatConversation;
  read: ChatReadState | undefined;
  onOpen: (e: React.MouseEvent) => void;
}) {
  const unread = Number(read?.unread ?? 0);
  const mentions = Number(read?.mentions ?? 0);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 py-[5px] pl-3.5 pr-2.5 text-left transition-colors hover:bg-element-hover cursor-pointer"
    >
      <RowIcon>
        {conv.visibility === "private" ? (
          <Lock size={12} className="text-disabled" />
        ) : (
          <Hash size={13} className="text-disabled" />
        )}
      </RowIcon>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          unread > 0 ? "font-medium text-foreground" : "text-secondary-foreground",
        )}
      >
        {conv.name}
      </span>
      <Badges unread={unread} mentions={mentions} />
    </button>
  );
}

/**
 * A direct conversation: ONE line, avatar with presence, name.
 *
 * It used to carry the counterpart's email on a second line. Nothing read it —
 * an address is not how you pick a person out of a list of eight faces — and it
 * cost every row a third of its height, so the section scrolled where it should
 * have fit. The email is still what `matches` searches, so typing one still
 * finds its owner; it just no longer occupies the rail to say so.
 *
 * The tempting replacement was "last active 5m ago", and it does not exist: the
 * presence frame is a binary online SET (`docs/chat/00-api-map.md`), the roster
 * comes from `get-full-organization` which carries no activity timestamp, and a
 * conversation's recency is a `seq`, not a time. Do not invent one.
 *
 * A group's member count stays, as a trailing figure rather than a subtitle —
 * it is the one thing about a group row that a name does not already tell you.
 */
function DirectRow({
  conv,
  read,
  members,
  online,
  me,
  onOpen,
}: {
  conv: ChatConversation;
  read: ChatReadState | undefined;
  members: Map<string, OrgMemberProfile>;
  online: string[];
  me: string;
  onOpen: (e: React.MouseEvent) => void;
}) {
  const unread = Number(read?.unread ?? 0);
  const mentions = Number(read?.mentions ?? 0);
  const isGroup = conv.kind === "group_dm";
  const others = (conv.member_ids ?? []).filter((id) => id !== me);
  const counterpart = !isGroup ? (members.get(others[0] ?? "") ?? null) : null;
  const title = conversationTitle(conv, members, me);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 py-[5px] pl-3.5 pr-2.5 text-left transition-colors hover:bg-element-hover cursor-pointer"
    >
      <RowIcon>
        {isGroup ? (
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-card text-muted-foreground">
            <Users size={12} />
          </span>
        ) : (
          <CommsAvatar
            member={counterpart}
            size={22}
            online={counterpart ? online.includes(counterpart.id) : false}
          />
        )}
      </RowIcon>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          unread > 0 ? "font-medium text-foreground" : "text-secondary-foreground",
        )}
      >
        {title}
      </span>
      {isGroup && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {others.length + 1}
        </span>
      )}
      <Badges unread={unread} mentions={mentions} />
    </button>
  );
}

/** A colleague with no DM yet. Same shape as a DirectRow on purpose. */
function ContactRow({
  member,
  online,
  starting,
  onStart,
}: {
  member: OrgMemberProfile;
  online: boolean;
  starting: boolean;
  onStart: () => void;
}) {
  return (
    <button
      type="button"
      disabled={starting}
      onClick={onStart}
      className="flex w-full items-center gap-2 py-[5px] pl-3.5 pr-2.5 text-left transition-colors hover:bg-element-hover disabled:opacity-60 cursor-pointer"
    >
      <RowIcon>
        <CommsAvatar member={member} size={22} online={online} />
      </RowIcon>
      <span className="min-w-0 flex-1 truncate text-sm text-secondary-foreground">
        {member.name}
      </span>
      {starting && <Loader2 size={12} className="shrink-0 animate-spin text-muted-foreground" />}
    </button>
  );
}

/**
 * Unread and mentions badge separately — a count and "someone named you" are
 * different signals. Both are server-held; nothing here counts locally.
 *
 * Both render as the hint-overlay keycap (⌘⌥Space): a monochrome, macOS-style
 * dark pill. A saturated fill turned out to fight the row — an avatar, a name
 * and a coloured pill is three things competing, and the count is the least
 * important of them until you are looking for it. Colour is reserved for the
 * presence and tab dots, which have no text to carry.
 *
 * The two are told apart by INK, not by fill: a mention takes the same yellow
 * the message body uses to highlight a mention of you.
 */
function Badges({ unread, mentions }: { unread: number; mentions: number }) {
  if (mentions > 0) {
    return <KeycapBadge ink="var(--foreground)" label={mentions > 9 ? "9+" : String(mentions)} />;
  }
  if (unread > 0) {
    return <KeycapBadge ink="var(--foreground)" label={unread > 99 ? "99+" : String(unread)} />;
  }
  return null;
}

/**
 * The keycap, on the same tokens as the `Kbd` primitive.
 *
 * It used to be the hint-overlay keycap verbatim: a hand-mixed dark gradient,
 * a white hairline and a three-layer inset shadow. `src/ui/kbd.tsx` has since
 * moved that look onto `border-border` + `bg-card` + the elevation
 * scale, so copying the old recipe no longer matched the thing it was copying.
 * It also could not survive a light theme: the cap was hardcoded dark while
 * the ink follows `--foreground`, which is dark ON a light theme — dark on
 * dark. Both sides are theme-derived now, so the pair stays legible either way.
 *
 * `backdrop-filter` is deliberately still NOT carried over: the hint badges
 * float above arbitrary app content and need to sample it, whereas these sit
 * on an opaque panel row where a blur has nothing to gather — it would add a
 * compositing layer per badge inside a `mix-blend-mode` panel that has already
 * proven touchy about exactly that.
 */
function KeycapBadge({ ink, label }: { ink: string; label: string }) {
  return (
    <span
      className="inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full border border-border bg-card px-1.5 font-sans text-2xs font-semibold leading-[16px] tabular-nums tracking-wide shadow-sm"
      style={{ color: ink }}
    >
      {label}
    </span>
  );
}
