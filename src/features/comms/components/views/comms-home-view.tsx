import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Hash, MessagesSquare, Search } from "lucide-react";
import {
  CommsConversationRow,
  ScrollFade,
  Skeleton,
  Spinner,
  useScrollEdges,
  type CommsConversationRowView,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";
import { CommsAvatar } from "../comms-avatar";
import { conversationTitle } from "../../lib/derive";
import { homeSections } from "../../lib/home-sections";
import type { LucideIcon } from "lucide-react";
import type { ChatConversation, ChatReadState, OrgMemberProfile } from "../../types";

export interface CommsHomeViewProps {
  conversations: ChatConversation[];
  discoverable: ChatConversation[];
  /** Read state by conversation id. */
  reads: Map<string, ChatReadState>;
  /** The roster by member id. */
  members: Map<string, OrgMemberProfile>;
  /** Ids of the members online now. */
  online: string[];
  me: string;
  /** The roster is still on its way: the DM sections show placeholder rows. */
  rosterPending: boolean;
  /** The colleague whose DM is being created, for the row's spinner. */
  startingDmId: string | null;
  /** The conversation on screen beside this list (the split view), lit. */
  activeConvId?: string | null;
  /** Laid out as the split view's left column rather than a full-width
   *  page: no fade-in, since it is there from the first frame. */
  sidebar?: boolean;
  /** `newTab` when the click was ⌘-click (Ctrl elsewhere). */
  onOpen: (convId: string, newTab: boolean) => void;
  onStartDm: (userId: string) => void;
  onJoin: (convId: string) => void;
  /** The Channels heading's control (the create-channel menu). */
  channelAction: ReactNode;
  /** The Direct messages heading's control (the new-message menu). */
  dmAction: ReactNode;
}

/** The list's edge fades: a ramp from the surface card it sits on. */
const FADE = "from-background via-background/80";

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
export function CommsHomeView({
  conversations,
  discoverable,
  reads,
  members,
  online,
  me,
  rosterPending,
  startingDmId,
  activeConvId = null,
  sidebar = false,
  onOpen,
  onStartDm,
  onJoin,
  channelAction,
  dmAction,
}: CommsHomeViewProps) {
  const [query, setQuery] = useState("");
  const [showDiscover, setShowDiscover] = useState(false);

  const { channels, groupDms, oneToOnes, contacts, discover } = useMemo(
    () => homeSections({ conversations, discoverable, members, me, query }),
    [conversations, discoverable, members, me, query],
  );
  const searching = query.trim() !== "";

  const listRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(listRef, [
    channels.length,
    groupDms.length,
    oneToOnes.length,
    contacts.length,
    showDiscover,
    rosterPending,
  ]);

  // ⌘-click (Ctrl elsewhere) opens a conversation in a tab of its own, the
  // way a browser link does; a plain click navigates this one. The row reads
  // the modifier and hands it over as `newTab`.
  const open = (convId: string, { newTab }: { newTab: boolean }) => onOpen(convId, newTab);

  return (
    <div
      data-view="comms-home"
      className={cn("flex min-w-0 flex-1 flex-col", !sidebar && "animate-fade-in")}
    >
      <div className="shrink-0 px-2 pt-2 pb-1">
        {/* Radius matches the surface card it sits in (CommsSurface's
            `rounded-xl`) — a tighter corner read as a different family. */}
        <label className="flex items-center gap-1.5 rounded-xl border border-border bg-panel-input px-2.5 py-[5px] focus-within:border-border-strong">
          <Search size={12} className="shrink-0 text-disabled" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a channel or person…"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-disabled"
          />
        </label>
      </div>

      {/* The fades sit on this wrapper, not the scroller, so they stay put
          while the rows scroll under them. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ScrollFade at="top" visible={edges.top} className={cn(FADE, "h-6")} />
        <ScrollFade at="bottom" visible={edges.bottom} className={cn(FADE, "h-6")} />
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto hide-scrollbar pb-3">
          <SectionLabel label="Channels" icon={Hash} action={channelAction} />
          {channels.map((c) => (
            <CommsConversationRow
              key={c.id}
              conversation={rowView(c, reads.get(c.id), c.name ?? "")}
              selected={c.id === activeConvId}
              onSelect={open}
            />
          ))}
          {channels.length === 0 && (
            <EmptyHint text={searching ? "No matching channels." : "No channels yet."} />
          )}

          <SectionLabel label="Direct messages" icon={MessagesSquare} action={dmAction} />
          {rosterPending &&
            [0, 1, 2].map((i) => (
              <div key={`sk${i}`} className="flex items-center gap-2 py-[5px] pl-3.5 pr-2.5">
                {/* Mirrors DirectRow exactly — same icon slot, same avatar size,
                    one line — so the roster landing does not shift the list. */}
                <RowIcon>
                  <span className="size-[22px] shrink-0 overflow-hidden rounded-full">
                    <Skeleton className="size-full" />
                  </span>
                </RowIcon>
                <Skeleton className="h-[9px]" style={{ width: 88 + ((i * 37) % 60) }} />
              </div>
            ))}
          {!rosterPending &&
            groupDms.map((c) => (
              <DirectRow
                key={c.id}
                conv={c}
                read={reads.get(c.id)}
                members={members}
                online={online}
                me={me}
                active={c.id === activeConvId}
                onOpen={open}
              />
            ))}
          {!rosterPending &&
            groupDms.length > 0 &&
            (oneToOnes.length > 0 || contacts.length > 0) && <RowDivider />}
          {!rosterPending &&
            oneToOnes.map((c) => (
              <DirectRow
                key={c.id}
                conv={c}
                read={reads.get(c.id)}
                members={members}
                online={online}
                me={me}
                active={c.id === activeConvId}
                onOpen={open}
              />
            ))}
          {!rosterPending &&
            contacts.map((m) => (
              <ContactRow
                key={m.id}
                member={m}
                online={online.includes(m.id)}
                starting={startingDmId === m.id}
                onStart={() => onStartDm(m.id)}
              />
            ))}
          {!rosterPending &&
            groupDms.length === 0 &&
            oneToOnes.length === 0 &&
            contacts.length === 0 && (
              <EmptyHint text={searching ? "Nobody matches." : "Nobody else is here yet."} />
            )}

          {discover.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowDiscover((v) => !v)}
                aria-expanded={showDiscover}
                className="mt-2 flex w-full cursor-pointer items-center gap-1.5 px-3 pb-1.5 pt-3.5 text-2xs font-semibold uppercase tracking-[0.06em] text-secondary-foreground transition-colors duration-fast hover:text-foreground"
              >
                <ChevronRight
                  size={10}
                  className={cn("transition-transform duration-fast", showDiscover && "rotate-90")}
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
                      onClick={() => onJoin(c.id)}
                      className="shrink-0 cursor-pointer rounded px-1.5 py-px text-xs font-medium text-secondary-foreground opacity-0 transition-opacity duration-fast hover:bg-element-hover hover:text-foreground group-hover/disc:opacity-100"
                    >
                      Join
                    </button>
                  </div>
                ))}
            </>
          )}
        </div>
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
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 pb-1.5 pt-3.5 text-2xs font-semibold uppercase tracking-[0.06em] text-secondary-foreground">
      <Icon size={12} className="shrink-0" />
      {label}
      {/* The `+` is a 20px control on a 14px line: the negative margin lets it
          overhang the label's padding rather than make the heading taller. */}
      {action && <span className="-my-[3px] ml-auto flex items-center">{action}</span>}
    </div>
  );
}

/**
 * The fixed-width icon slot the package row leads with (`w-7`), restated for
 * the rows that are not conversations (roster placeholders, Discover), so
 * their labels start at the same x as every conversation's.
 */
function RowIcon({ children }: { children: ReactNode }) {
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

/**
 * Desktop's conversation in the package row's shape. Unread and mentions are
 * server-held and passed through; the row draws the keycap badge (a mention
 * outranks a plain count, 9+ against 99+).
 */
function rowView(
  conv: ChatConversation,
  read: ChatReadState | undefined,
  title: string,
): CommsConversationRowView {
  return {
    id: conv.id,
    kind: conv.kind === "group_dm" ? "group" : conv.kind,
    title,
    private: conv.visibility === "private",
    unread: Number(read?.unread ?? 0),
    mentions: Number(read?.mentions ?? 0),
  };
}

/**
 * A direct conversation: ONE line, avatar with presence, name.
 *
 * It used to carry the counterpart's email on a second line. Nothing read it —
 * an address is not how you pick a person out of a list of eight faces — and it
 * cost every row a third of its height, so the section scrolled where it should
 * have fit. A colleague's email is still what the search matches on their
 * contact row; it just no longer occupies the rail to say so.
 *
 * The tempting replacement was "last active 5m ago", and it does not exist: the
 * presence frame is a binary online SET (`docs/chat/00-api-map.md`), the roster
 * comes from `get-full-organization` which carries no activity timestamp, and a
 * conversation's recency is a `seq`, not a time. Do not invent one.
 *
 * A group's member count stays, as a trailing figure rather than a subtitle —
 * it is the one thing about a group row that a name does not already tell you.
 *
 * A 1:1's face is `CommsAvatar` in the row's icon slot, not the row's own
 * `PersonAvatar`: that one swaps a broken photo for initials, a behaviour
 * change still awaiting review (ATL-718).
 */
function DirectRow({
  conv,
  read,
  active = false,
  members,
  online,
  me,
  onOpen,
}: {
  conv: ChatConversation;
  read: ChatReadState | undefined;
  active?: boolean;
  members: Map<string, OrgMemberProfile>;
  online: string[];
  me: string;
  onOpen: (convId: string, select: { newTab: boolean }) => void;
}) {
  const isGroup = conv.kind === "group_dm";
  const others = (conv.member_ids ?? []).filter((id) => id !== me);
  const counterpart = !isGroup ? (members.get(others[0] ?? "") ?? null) : null;

  return (
    <CommsConversationRow
      conversation={rowView(conv, read, conversationTitle(conv, members, me))}
      selected={active}
      onSelect={onOpen}
      icon={
        isGroup ? undefined : (
          <CommsAvatar
            member={counterpart}
            size={22}
            online={counterpart ? online.includes(counterpart.id) : false}
          />
        )
      }
      trailing={
        isGroup ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {others.length + 1}
          </span>
        ) : undefined
      }
    />
  );
}

/** A colleague with no DM yet: the same row as a DM's, keyed by member id. */
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
    <CommsConversationRow
      conversation={{ id: member.id, kind: "dm", title: member.name, unread: 0, mentions: 0 }}
      onSelect={onStart}
      disabled={starting}
      icon={<CommsAvatar member={member} size={22} online={online} />}
      trailing={starting ? <Spinner size="sm" label="" /> : undefined}
    />
  );
}
