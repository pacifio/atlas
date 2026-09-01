// Pure derivations for the comms UI. Everything here is a function of wire
// state — no I/O, no store access — so the awkward parts (reaction counts,
// speaker grouping, DM titles) stay testable without a socket.

import type { ChatConversation, ChatReaction, CommsMessage, OrgMemberProfile } from "../types";

/** The server sends reaction ROWS and no aggregate; this is where counts come
 *  from. Ordered by first appearance so the chips don't reshuffle on a change. */
export interface ReactionChip {
  emoji: string;
  count: number;
  /** Whether the current user is in this group — drives the `on` we send back. */
  mine: boolean;
  /** For the tooltip. */
  userIds: string[];
}

export function aggregateReactions(
  rows: ChatReaction[],
  messageId: string,
  me: string,
): ReactionChip[] {
  const order: string[] = [];
  const byEmoji = new Map<string, ReactionChip>();
  for (const r of rows) {
    if (r.message_id !== messageId) continue;
    let chip = byEmoji.get(r.emoji);
    if (!chip) {
      chip = { emoji: r.emoji, count: 0, mine: false, userIds: [] };
      byEmoji.set(r.emoji, chip);
      order.push(r.emoji);
    }
    chip.count += 1;
    chip.userIds.push(r.user_id);
    if (r.user_id === me) chip.mine = true;
  }
  return order.map((e) => byEmoji.get(e)!);
}

/** Consecutive messages from one author, close in time, render as one stack
 *  with a single avatar and header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export interface MessageGroup {
  key: string;
  authorId: string;
  /** True when the current user wrote them. Layout no longer varies on this —
   *  the transcript is linear — but authorship still decides who may edit. */
  own: boolean;
  messages: CommsMessage[];
}

export function groupMessages(messages: CommsMessage[], me: string): MessageGroup[] {
  const groups: MessageGroup[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    const previous = last?.messages[last.messages.length - 1];
    const contiguous =
      last &&
      previous &&
      last.authorId === m.author_id &&
      // A reply starts a new stack — the quoted parent needs its own head.
      !m.reply_to_id &&
      // A day boundary always starts a new stack. The day divider is drawn
      // BETWEEN groups, so without this two messages minutes apart either side
      // of midnight would stay in one group and the divider would never render.
      !crossesDay(previous.created_at, m.created_at) &&
      m.created_at - previous.created_at < GROUP_WINDOW_MS;
    if (contiguous) last.messages.push(m);
    else
      groups.push({
        key: m.id,
        authorId: m.author_id,
        own: m.author_id === me,
        messages: [m],
      });
  }
  return groups;
}

function crossesDay(a: number, b: number): boolean {
  return new Date(a).toDateString() !== new Date(b).toDateString();
}

/** A day separator is drawn whenever the calendar date changes. */
export function isNewDay(prev: CommsMessage | undefined, cur: CommsMessage): boolean {
  if (!prev) return true;
  return crossesDay(prev.created_at, cur.created_at);
}

/** `at` is epoch milliseconds, as everything on this wire is. */
export function formatDayDivider(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

/** Intl is measurably the cost of a transcript render (~2 calls per row), and
 *  a timestamp's formatting never changes — cache it. Bounded FIFO. */
const clockCache = new Map<number, string>();
export function formatClock(at: number): string {
  const hit = clockCache.get(at);
  if (hit) return hit;
  const formatted = new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (clockCache.size >= 1024) {
    const oldest = clockCache.keys().next().value;
    if (oldest !== undefined) clockCache.delete(oldest);
  }
  clockCache.set(at, formatted);
  return formatted;
}

/** Channels carry a name; DMs are titled from the members who are not us. */
export function conversationTitle(
  conv: ChatConversation,
  members: Map<string, OrgMemberProfile>,
  me: string,
): string {
  if (conv.kind === "channel") return conv.name ?? "channel";
  const others = (conv.member_ids ?? []).filter((id) => id !== me);
  const names = others.map((id) => members.get(id)?.name ?? "Unknown");
  if (names.length === 0) return "Empty conversation";
  if (names.length <= 2) return names.join(" & ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

/** The other party in a 1:1 DM, for the avatar and presence dot. */
export function dmCounterpart(
  conv: ChatConversation,
  members: Map<string, OrgMemberProfile>,
  me: string,
): OrgMemberProfile | null {
  if (conv.kind !== "dm") return null;
  const other = (conv.member_ids ?? []).find((id) => id !== me);
  return other ? (members.get(other) ?? null) : null;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stable per-user hue so an avatar keeps its colour across sessions. Kept in
 *  the muted band so a wall of avatars never out-shouts the text. */
export function avatarHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Body limits are in UTF-8 BYTES, not characters — emoji and CJK count 3–4×. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Sort for the sidebar: most recent activity first. */
export function byRecency(a: ChatConversation, b: ChatConversation): number {
  return b.last_activity_seq - a.last_activity_seq;
}
