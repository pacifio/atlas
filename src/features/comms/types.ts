// Wire types for team chat (the `atlas-chat` API), mirrored from the server's
// `packages/contracts/src/chat.ts` — that file wins on any conflict. Kept as a
// hand-mirror rather than a generated copy because the desktop consumes a strict
// subset; anything added here must exist there under the same name.
//
// NOTE: `src/features/chat` is the AGENT chat. This namespace (`comms`) is the
// team chat and the two must never share a type name across an import.

export type ConversationKind = "channel" | "dm" | "group_dm";
export type ConversationVisibility = "public_org" | "private";

/**
 * One conversation. The same shape covers channels, DMs and group DMs.
 *
 * NOTE ON TIMES: every timestamp on this wire is an **epoch-millisecond
 * integer**, not an ISO string (`z.number().int()` throughout
 * `packages/contracts/src/chat.ts`). Formatting happens at render.
 */
export interface ChatConversation {
  id: string;
  kind: ConversationKind;
  /** Channels only; DMs are titled from their members. */
  name: string | null;
  visibility: ConversationVisibility;
  /** Atlas-specific: a channel can be tagged to workspaces. */
  workspace_ref_ids: string[];
  created_by: string;
  created_at: number;
  archived_at: number | null;
  seq: number;
  /** Populated for dm/group_dm; **null for a channel** — a channel roster is
   *  never broadcast org-wide. */
  member_ids: string[] | null;
  last_activity_seq: number;
}

export interface ChatAttachment {
  id: string;
  filename: string;
  content_type: string;
  /** Measured at upload completion, not the declared size. */
  bytes: number;
}

/** A pointer at a range of a file. Server-side `planned`; rendered read-only. */
export interface ChatCodeRef {
  path: string;
  start_line?: number;
  end_line?: number;
  sha?: string;
}

export interface ChatMessage {
  id: string;
  conv_id: string;
  seq: number;
  author_id: string;
  body: string;
  reply_to_id: string | null;
  edited_at: number | null;
  created_at: number;
  attachments: ChatAttachment[];
  code_refs: ChatCodeRef[];
  draft_id: string | null;
}

/** The server sends reaction ROWS, never aggregates — counts are derived. */
export interface ChatReaction {
  message_id: string;
  user_id: string;
  emoji: string;
}

/** Unread counts are server-held. Never compute these locally. */
export interface ChatReadState {
  conv_id: string;
  last_read_seq: number;
  unread: number;
  mentions: number;
}

export type CallMode = "audio" | "video";
export type CallRecordingState =
  | "off"
  | "starting"
  | "recording"
  | "processing"
  | "ready"
  | "failed";
export type CallTranscriptState = "none" | "pending" | "ready" | "failed";

/**
 * A call, as the timeline knows it.
 *
 * Assembled from journaled frames, never from REST: `GET /calls` answers LIVE
 * calls only, because an ended call is a timeline card and the timeline is the
 * journal's job. A resume therefore replays call history for free.
 */
export interface ChatCall {
  id: string;
  conv_id: string | null;
  mode: CallMode;
  started_by: string;
  started_at: number;
  ended_at: number | null;
  seq: number;
  transcript_state: CallTranscriptState;
  join_slug: string | null;
  recording_state: CallRecordingState;
}

/** A pin, as `GET /conversations/{id}/pins` answers: the message rides with
 *  it so a rail (or a menu) renders in one request. */
export interface ChatPin {
  conv_id: string;
  message_id: string;
  pinned_by: string;
  at: number;
  message: ChatMessage | null;
}

/** A Prompt Draft's metadata — never its content (the server stores opaque
 *  Yjs bytes it cannot read). `title` is write-once; no rename/delete routes
 *  exist yet, and no lifecycle frames — lists refresh by poll. */
export interface PromptDraft {
  id: string;
  conv_id: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  sent_by: string | null;
  sent_message_id: string | null;
}

/** One participant's recorded track. The URL is a 60-second mint. */
export interface RecordingTrack {
  id: string;
  filename: string;
  bytes: number;
  url: string;
}

/** A member of the active org, from `get-full-organization`. */
export interface OrgMemberProfile {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  role: "admin" | "product_owner" | "developer" | "member";
}

/**
 * Local-only send status. The ladder has exactly TWO rungs by design: there is
 * one `ack`, from the server, to the sender, and nothing reports that a message
 * reached anyone's device. A "delivered" or "read" rung would be a lie.
 */
export type SendStatus = "sending" | "sent" | "failed";

/** A transcript row: a wire message plus the local-only fields the UI needs. */
export interface CommsMessage extends ChatMessage {
  /** Set while optimistic; the `ack` reconciles it. */
  client_msg_id?: string;
  status?: SendStatus;
  /** True once `message.deleted` lands — the row stays, the body goes. */
  deleted?: boolean;
}

/**
 * The allowlist, vendored verbatim (order included) from the server's
 * `CHAT_REACTION_EMOJI` (`packages/contracts/src/chat.ts`). A `react` carrying
 * anything else is a `400`, so the picker is built FROM this array and cannot
 * offer a button the server would refuse.
 *
 * Written as escapes, as the server writes them: `❤️` and `⚠️` carry a variation
 * selector, and a stored reaction has to be byte-identical to what was allowed.
 * Every entry is a single grapheme — no ZWJ sequences whose identity depends on
 * the sender's keyboard.
 */
export const CHAT_REACTION_EMOJI = [
  "\u{1F44D}", // thumbs up
  "\u{1F44E}", // thumbs down
  "\u{1F602}", // tears of joy
  "\u{1F389}", // party popper
  "\u{1F440}", // eyes
  "\u{1F680}", // rocket
  "\u{1F525}", // fire
  "\u{1F914}", // thinking
  "\u{1F621}", // pouting
  "\u{1F62E}", // astonished
  "\u{1F64F}", // folded hands
  "\u{1F4AF}", // hundred points
  "\u{1F41B}", // bug
  "\u{1F44F}", // clapping hands
  "\u{2764}\u{FE0F}", // red heart
  "\u{2705}", // check mark button
  "\u{274C}", // cross mark
  "\u{26A0}\u{FE0F}", // warning
  "\u{1F44C}", // OK hand
  "\u{1F937}", // shrug
] as const;

export type ReactionEmoji = (typeof CHAT_REACTION_EMOJI)[number];

export function isAllowedReaction(emoji: string): emoji is ReactionEmoji {
  return (CHAT_REACTION_EMOJI as readonly string[]).includes(emoji);
}

// ---------------------------------------------------------------------------
// Mentions
//
// Bodies store `<@user_id>` tokens and are resolved AT RENDER TIME against the
// member directory, so a rename changes rendering and never history. These
// patterns are the server's (`MENTION_SOURCE` / `BROADCAST_SOURCE`) — a second
// regex would highlight people nobody was notified about.
// ---------------------------------------------------------------------------

export const MENTION_SOURCE = "<@([A-Za-z0-9_.:-]{1,128})>";
export const BROADCAST_SOURCE = "(?<![\\w@])@(channel|here)\\b";

export type MentionKind = "user" | "channel" | "here";

export interface ParsedMention {
  kind: MentionKind;
  /** User id for `user`; the literal word for `channel` / `here`. */
  id: string;
  start: number;
  end: number;
}

/** Mirrors the server's `parseMentions`. Same pattern, same ordering. */
export function parseMentions(body: string): ParsedMention[] {
  const out: ParsedMention[] = [];
  const user = new RegExp(MENTION_SOURCE, "g");
  for (let m = user.exec(body); m; m = user.exec(body)) {
    out.push({ kind: "user", id: m[1], start: m.index, end: m.index + m[0].length });
  }
  const broadcast = new RegExp(BROADCAST_SOURCE, "g");
  for (let m = broadcast.exec(body); m; m = broadcast.exec(body)) {
    out.push({
      kind: m[1] === "channel" ? "channel" : "here",
      id: m[1],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Limits, from the contract. Enforced client-side so the server never has to
// refuse something the composer allowed.
// ---------------------------------------------------------------------------

export const CHAT_BODY_MAX_BYTES = 16_384;
export const CHANNEL_NAME_MAX = 80;
export const CHAT_MESSAGE_ATTACHMENT_MAX = 10;
export const CHAT_PIN_LIMIT = 100;
export const CHAT_TYPING_INTERVAL_MS = 3_000;
/** No "stopped typing" frame exists, ever — hints age out on this timer. */
export const TYPING_EXPIRY_MS = 6_000;
