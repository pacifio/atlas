import { memo, useCallback, useMemo } from "react";
import { copyText } from "@/lib/clipboard";
import { authorLabel, isWebhookMessage } from "../lib/message-author";
import { toPlainText } from "../lib/to-plain-text";
import { aggregateReactions } from "../lib/derive";
import { useCommsStore } from "../stores/comms-store";
import { MessageAttachment } from "./message-attachment";
import { MessageBody } from "./message-body";
import { SessionReferenceCard } from "./session-reference-card";
import { MessageRowView } from "./views/message-row-view";
import { CHAT_REACTION_EMOJI } from "../types";
import type { CommsMessage, OrgMemberProfile } from "../types";

/**
 * One author's run of messages, rendered LINEAR (see `MessageRowView`).
 *
 * There are no bubbles and no side-switching. The panel is ~390px wide, and a
 * `max-w-[88%]` bubble in that space wrapped almost every sentence and left the
 * timestamp colliding with the text; a linear row gives the body the whole
 * column. `own` therefore no longer changes layout at all — it only decides who
 * is offered Edit.
 */
interface MessageGroupProps {
  messages: CommsMessage[];
  own: boolean;
  author: OrgMemberProfile | null;
  members: Map<string, OrgMemberProfile>;
  me: string;
  /** Resolves a `reply_to_id` for the quote line. */
  lookup: (id: string) => CommsMessage | undefined;
  onReply: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onReact: (id: string, emoji: string, on: boolean) => void;
  onPin: (id: string, on: boolean) => void;
  /** Jump the transcript to a message id (reply quotes, pin entries). */
  onJump: (id: string) => void;
  /** Channels and group DMs name the author; a 1:1 DM does not need to. */
  showAuthor: boolean;
}

export const MessageGroup = memo(function MessageGroup({
  messages,
  own,
  author,
  members,
  me,
  lookup,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onPin,
  onJump,
  showAuthor,
}: MessageGroupProps) {
  return (
    <div className="px-2 py-1.5" data-view="comms-message-group">
      {messages.map((m, i) => (
        <MessageRow
          key={m.id}
          message={m}
          first={i === 0}
          own={own}
          author={author}
          members={members}
          me={me}
          // Resolved HERE, not in the row: `lookup` is rebuilt whenever any
          // message arrives, and as a row prop it re-rendered every row on
          // every new message. The parent object itself keeps its identity.
          replyParent={m.reply_to_id ? lookup(m.reply_to_id) : undefined}
          onReply={onReply}
          onEdit={onEdit}
          onDelete={onDelete}
          onReact={onReact}
          onPin={onPin}
          onJump={onJump}
          showAuthor={showAuthor}
        />
      ))}
    </div>
  );
});

/**
 * One message. The unit of re-render.
 *
 * **Reactions and pin state are subscribed HERE, per message id.** The store
 * indexes reactions by message and a selector returning this row's slice (or a
 * boolean) means a reaction anywhere else changes nothing about this fiber. The
 * author's presence follows the same rule, keyed by author id instead — see
 * `authorOnline` below.
 */
const MessageRow = memo(function MessageRow({
  message: m,
  first,
  own,
  author,
  members,
  me,
  replyParent,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onPin,
  onJump,
  showAuthor,
}: {
  message: CommsMessage;
  first: boolean;
  own: boolean;
  author: OrgMemberProfile | null;
  members: Map<string, OrgMemberProfile>;
  me: string;
  replyParent: CommsMessage | undefined;
  onReply: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onReact: (id: string, emoji: string, on: boolean) => void;
  onPin: (id: string, on: boolean) => void;
  onJump: (id: string) => void;
  showAuthor: boolean;
}) {
  const pinned = useCommsStore((s) => s.pinned.includes(m.id));
  // Presence is subscribed per AUTHOR, for exactly the reason pin state is
  // subscribed per message: `online` is an ORG-WIDE set that is re-sent whole
  // whenever anyone anywhere connects or drops, so a row holding the array
  // would re-render on a stranger's reconnect. A boolean selector re-renders
  // this fiber only when THIS author's presence actually flips.
  //
  // `undefined` when the author is unresolved — CommsAvatar then draws no dot
  // at all, which is honest: we do not know who they are, so we cannot know
  // whether they are here. A `false` would assert "offline" about a stranger.
  //
  // Self is forced online rather than read from the set: you are demonstrably
  // connected if this is rendering, and whether the server echoes your own id
  // back in `presence` is not something the API map promises either way.
  const authorOnline = useCommsStore((s) =>
    author ? author.id === me || s.online.includes(author.id) : undefined,
  );
  // Per-message subscription: a reaction on any OTHER message changes nothing
  // here. The slice keeps identity unless this message's rows changed.
  const reactionRows = useCommsStore((s) => s.reactionsByMessage[m.id]);
  const reactions = useMemo(
    () => (reactionRows ? aggregateReactions(reactionRows, m.id, me) : []),
    [reactionRows, m.id, me],
  );

  const memberName = useCallback((id: string) => members.get(id)?.name ?? "Unknown", [members]);
  const replyParentName = replyParent
    ? isWebhookMessage(replyParent)
      ? authorLabel(replyParent, memberName)
      : (members.get(replyParent.author_id)?.name ?? "Unknown")
    : "Unknown";
  // Flattened: a one-line stub must not quote raw `**markers**` or an
  // internal `<@u_…>` id back at the reader.
  const replyPreview = useMemo(
    () => (replyParent && !replyParent.deleted ? toPlainText(replyParent.body, members) : ""),
    [replyParent, members],
  );

  const id = m.id;
  const replyTo = m.reply_to_id;
  const react = useCallback((emoji: string, on: boolean) => onReact(id, emoji, on), [onReact, id]);
  const reply = useCallback(() => onReply(id), [onReply, id]);
  const edit = useCallback(() => onEdit(id), [onEdit, id]);
  const del = useCallback(() => onDelete(id), [onDelete, id]);
  const pin = useCallback(() => onPin(id, !pinned), [onPin, id, pinned]);
  const copy = useCallback(() => void copyText(m.body), [m.body]);
  const jump = useCallback(() => {
    if (replyTo) onJump(replyTo);
  }, [onJump, replyTo]);

  const references = m.artifact_refs ?? [];

  return (
    <MessageRowView
      message={m}
      first={first}
      author={author}
      authorOnline={authorOnline}
      showAuthor={showAuthor}
      pinned={pinned}
      reactions={reactions}
      memberName={memberName}
      replyParent={replyParent}
      replyParentName={replyParentName}
      replyPreview={replyPreview}
      canEdit={own && !m.deleted}
      canDelete={!m.deleted}
      reactionEmoji={CHAT_REACTION_EMOJI}
      onReact={react}
      onReply={reply}
      onEdit={edit}
      onDelete={del}
      onPin={pin}
      onCopy={copy}
      onJumpToParent={jump}
      body={
        <MessageBody
          body={m.body}
          members={members}
          me={me}
          className="min-w-0 flex-1 text-secondary-foreground"
        />
      }
      attachments={m.attachments.map((a) => (
        <MessageAttachment key={a.id} attachment={a} convId={m.conv_id} />
      ))}
      references={references.map((r) => (
        <SessionReferenceCard
          key={`${r.kind}:${r.session_id}:${r.kind === "checkpoint" ? r.row_id : ""}`}
          reference={r}
        />
      ))}
    />
  );
});
