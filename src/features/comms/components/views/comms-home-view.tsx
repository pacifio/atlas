import { useMemo, useState, type ReactNode } from "react";
import { ChevronRight, Hash, Lock, MessagesSquare, Search, Users } from "lucide-react";
import { Skeleton, Spinner } from "@tryatlas/design";
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
  // ⌘-click (Ctrl elsewhere) opens a conversation in a tab of its own, the
  // way a browser link does; a plain click navigates this one.
  const open = (convId: string, e: React.MouseEvent) => onOpen(convId, e.metaKey || e.ctrlKey);

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

      <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar pb-3">
        <SectionLabel label="Channels" icon={Hash} action={channelAction} />
        {channels.map((c) => (
          <ChannelRow
            key={c.id}
            conv={c}
            read={reads.get(c.id)}
            active={c.id === activeConvId}
            onOpen={(e) => open(c.id, e)}
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
              read={reads.get(c.id)}
              members={members}
              online={online}
              me={me}
              active={c.id === activeConvId}
              onOpen={(e) => open(c.id, e)}
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
 * Every row leads with an icon in a fixed-width slot — a channel's `#`, a
 * person's avatar, a group's glyph — so labels start at the same x whatever the
 * row is. Without it the `#` (13px) and an avatar (26px) put their text in two
 * different columns, which is what made the sections look unrelated.
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

function ChannelRow({
  conv,
  read,
  active = false,
  onOpen,
}: {
  conv: ChatConversation;
  read: ChatReadState | undefined;
  active?: boolean;
  onOpen: (e: React.MouseEvent) => void;
}) {
  const unread = Number(read?.unread ?? 0);
  const mentions = Number(read?.mentions ?? 0);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active || undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 py-[5px] pl-3.5 pr-2.5 text-left transition-colors duration-fast",
        active ? "bg-element-active" : "hover:bg-element-hover",
      )}
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
          unread > 0
            ? "font-medium text-foreground"
            : active
              ? "text-foreground"
              : "text-secondary-foreground",
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
      aria-current={active || undefined}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 py-[5px] pl-3.5 pr-2.5 text-left transition-colors duration-fast",
        active ? "bg-element-active" : "hover:bg-element-hover",
      )}
    >
      <RowIcon>
        {isGroup ? (
          <span className="flex size-[22px] items-center justify-center rounded-full bg-card text-muted-foreground">
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
          unread > 0
            ? "font-medium text-foreground"
            : active
              ? "text-foreground"
              : "text-secondary-foreground",
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
      className="flex w-full cursor-pointer items-center gap-2 py-[5px] pl-3.5 pr-2.5 text-left transition-colors duration-fast hover:bg-element-hover disabled:opacity-60"
    >
      <RowIcon>
        <CommsAvatar member={member} size={22} online={online} />
      </RowIcon>
      <span className="min-w-0 flex-1 truncate text-sm text-secondary-foreground">
        {member.name}
      </span>
      {starting && <Spinner size="sm" label="" />}
    </button>
  );
}

/**
 * Unread and mentions badge separately — a count and "someone named you" are
 * different signals. Both are server-held; nothing here counts locally. A row
 * with mentions shows only the mention count.
 *
 * Both render as the hint-overlay keycap (⌘⌥Space): a monochrome, macOS-style
 * pill. A saturated fill turned out to fight the row — an avatar, a name and a
 * coloured pill is three things competing, and the count is the least
 * important of them until you are looking for it. Colour is reserved for the
 * presence and tab dots, which have no text to carry.
 */
function Badges({ unread, mentions }: { unread: number; mentions: number }) {
  if (mentions > 0) return <KeycapBadge label={mentions > 9 ? "9+" : String(mentions)} />;
  if (unread > 0) return <KeycapBadge label={unread > 99 ? "99+" : String(unread)} />;
  return null;
}

/**
 * The keycap, on the same tokens as the `Kbd` primitive: `border-border`,
 * `bg-card` and the elevation scale, with the ink on `--foreground`, so the
 * pair stays legible on a light theme as on a dark one.
 *
 * `backdrop-filter` is deliberately NOT carried over from the hint badges:
 * those float above arbitrary app content and need to sample it, whereas these
 * sit on an opaque panel row where a blur has nothing to gather — it would add
 * a compositing layer per badge inside a `mix-blend-mode` panel that has
 * already proven touchy about exactly that.
 */
function KeycapBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex min-w-[18px] shrink-0 items-center justify-center rounded-full border border-border bg-card px-1.5 font-sans text-2xs font-semibold leading-[16px] tabular-nums tracking-wide text-foreground shadow-sm">
      {label}
    </span>
  );
}
