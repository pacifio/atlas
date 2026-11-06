/**
 * Chat notification rules — pure. A DM or group DM message to the user, or an
 * @mention of the user (`<@id>`, `@channel`, `@here`) in a channel, becomes a
 * `chat-dm` / `chat-mention` event; everything else is silence.
 *
 * Never notifies for: the user's own messages, an unknown `me` (before the first
 * snapshot every author would look foreign), a deleted message, or a message
 * whose conversation is not in the joined list. The Chat model has no muting,
 * so there is no mute rule to honour yet.
 */
import { conversationTitle } from "@/features/comms/lib/derive";
import { authorLabel } from "@/features/comms/lib/message-author";
import {
  parseMentions,
  type ChatConversation,
  type OrgMemberProfile,
} from "@/features/comms/types";
import type { CommsMessage } from "@/features/comms/types";
import { decideNotification, type NotificationEnv, type NotificationEvent } from "./decide";
import type { NotificationDecision, NotificationPrefs } from "./decide";

/** One line, this long at most — banner and toast bodies are glanceable. */
export const CHAT_BODY_MAX = 120;

const UNKNOWN_NAME = "Someone";

export interface ChatCtx {
  me: string;
  members: Map<string, OrgMemberProfile>;
  orgId?: string;
}

/** Does `body` ping `me`? Broadcast mentions (`@channel`, `@here`) count. */
export function mentionsUser(body: string, me: string): boolean {
  return parseMentions(body).some((m) => m.kind !== "user" || m.id === me);
}

/** `<@id>` tokens as `@Name`, whitespace collapsed to one line, trimmed. */
export function chatPreview(
  body: string,
  members: Map<string, OrgMemberProfile>,
  max = CHAT_BODY_MAX,
): string {
  let out = "";
  let at = 0;
  for (const m of parseMentions(body)) {
    if (m.kind !== "user" || m.start < at) continue;
    out += body.slice(at, m.start) + `@${members.get(m.id)?.name ?? UNKNOWN_NAME}`;
    at = m.end;
  }
  out += body.slice(at);
  const line = out.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

export function classifyChatMessage(
  message: CommsMessage,
  conversation: ChatConversation | undefined,
  ctx: ChatCtx,
): NotificationEvent | null {
  if (!ctx.me || !conversation || message.deleted) return null;
  if (message.author_id === ctx.me) return null;

  const isDirect = conversation.kind !== "channel";
  if (!isDirect && !mentionsUser(message.body, ctx.me)) return null;

  // An integration is named as one ("CI (app)"), never looked up as a member.
  const sender = authorLabel(message, (id) => ctx.members.get(id)?.name ?? UNKNOWN_NAME);
  const where = conversationTitle(conversation, ctx.members, ctx.me);
  const title =
    conversation.kind === "dm"
      ? sender
      : conversation.kind === "group_dm"
        ? `${sender} · ${where}`
        : `${sender} · #${where}`;
  const preview = chatPreview(message.body, ctx.members);

  return {
    kind: isDirect ? "chat-dm" : "chat-mention",
    title,
    body: preview || (message.attachments.length > 0 ? "Sent an attachment" : ""),
    target: { type: "chat-conversation", convId: conversation.id, orgId: ctx.orgId },
    dedupeKey: message.id,
  };
}

export function decideChatNotification(
  message: CommsMessage,
  conversation: ChatConversation | undefined,
  ctx: ChatCtx,
  env: NotificationEnv,
  prefs: NotificationPrefs = {},
): NotificationDecision | null {
  const event = classifyChatMessage(message, conversation, ctx);
  return event ? decideNotification(event, env, prefs) : null;
}
