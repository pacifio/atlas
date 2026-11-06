// One comment in a thread: byline, body (or its edit), votes, and the
// root's Resolve and Reply. Props only.

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ArrowBigDown, ArrowBigUp, Check, Link2, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { CommenterAvatar, GuestChip } from "@/components/commenter-avatar";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/format-time";

import { toEditable, toWireBody } from "../../lib/comment-edit";
import { selectionCommentBody, splitSelectionComment } from "../../lib/selection-comment";
import type { Comment } from "../../lib/session-detail-context";
import { NO_VOTES, nextVote, voteOf } from "../../lib/votes";
import type { CommentActions } from "../comment-thread";
import { CommentBody, Composer, SelectionExcerpt } from "./comment-composer-view";
import { AVATAR_PX, REPLY_INDENT } from "./comment-thread-styles";

export const CommentRow = memo(function CommentRow({
  comment,
  directory,
  actions,
  isRoot,
  onReply,
}: {
  comment: Comment;
  directory: OrgDirectory;
  actions: CommentActions;
  isRoot: boolean;
  onReply?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  /** The body is open in a composer in place of the text. */
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement | null>(null);
  /** Leaving the edit hands focus back to the pencil that opened it, rather
   *  than dropping it on the body when the field unmounts. */
  const returnFocus = useRef(false);
  const stopEditing = useCallback(() => {
    returnFocus.current = true;
    setEditing(false);
  }, []);
  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    editButton.current?.focus();
  }, [editing]);
  // A guest is never resolved against the roster, even if an id collides.
  const member = comment.guestName ? null : (directory.byId.get(comment.authorId) ?? null);
  // Never the raw id: an opaque key in a byline is not a name, and it is what
  // this thread used to print for every single comment.
  const name = comment.guestName ?? member?.name ?? "A member";
  const mine = directory.currentUserId !== null && comment.authorId === directory.currentUserId;
  const resolved = comment.resolvedAt !== null;
  const excerpt = splitSelectionComment(comment.body ?? "");
  const editableBody = excerpt?.body ?? comment.body ?? "";

  if (comment.deletedAt) {
    // The row survives so replies keep their places, and saying so is more
    // honest than a gap where a comment used to be.
    return (
      <p className="text-2xs italic text-disabled" style={{ paddingLeft: REPLY_INDENT }}>
        Comment deleted
      </p>
    );
  }

  const run = (action: () => Promise<void>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };

  return (
    <div className={cn("group/comment", resolved && "opacity-55")}>
      <div className="flex items-start gap-1.5">
        <span className="mt-px shrink-0">
          <CommenterAvatar
            commenter={{ authorId: comment.authorId, guestName: comment.guestName }}
            directory={directory}
            size={AVATAR_PX}
          />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="min-w-0 truncate text-xs font-medium text-[var(--foreground)]">
              {name}
            </span>
            {comment.guestName && <GuestChip />}
            <span className="shrink-0 font-mono text-3xs text-disabled">
              {time(comment.createdAt)}
            </span>
            {comment.editedAt && <span className="shrink-0 text-3xs text-disabled">edited</span>}
            <span className="flex-1" />
            {busy && <Loader2 size={10} className="animate-spin text-[var(--muted-foreground)]" />}
            {/* Link first, then delete. Every comment can be linked — it
             *  tells the agent "attend to this one" — so it is not gated on
             *  authorship the way delete is. */}
            {actions.link && !busy && (
              <button
                type="button"
                aria-label="Reference comment in a session"
                title="Reference in a session"
                onClick={() => actions.link?.(comment)}
                className="flex shrink-0 cursor-pointer items-center rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition-colors hover:text-[var(--foreground)] focus-visible:opacity-100 group-hover/comment:opacity-100"
              >
                <Link2 size={11} />
              </button>
            )}
            {/* Edit and delete are the author's alone — the server refuses
             *  anyone else either way. Inline buttons rather than an overflow
             *  menu: two actions are not worth a click in front of them. */}
            {mine && !busy && !editing && actions.edit && (
              <button
                ref={editButton}
                type="button"
                aria-label="Edit comment"
                title="Edit"
                onClick={() => setEditing(true)}
                className="flex shrink-0 cursor-pointer items-center rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition-colors hover:text-[var(--foreground)] focus-visible:opacity-100 group-hover/comment:opacity-100"
              >
                <Pencil size={11} />
              </button>
            )}
            {mine && !busy && (
              <button
                type="button"
                aria-label="Delete comment"
                onClick={() => run(() => actions.remove(comment.id))}
                className="flex shrink-0 cursor-pointer items-center rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition-colors hover:text-error focus-visible:opacity-100 group-hover/comment:opacity-100"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>

          {editing && actions.edit ? (
            <div className="mt-1">
              {excerpt && <SelectionExcerpt text={excerpt.selection} />}
              <Composer
                placeholder="Edit comment…"
                directory={directory}
                autoFocus
                ariaLabel="Edit comment"
                initial={toEditable(editableBody, directory)}
                bodyPrefixLength={excerpt ? selectionCommentBody(excerpt.selection, "").length : 0}
                onCancel={stopEditing}
                onSend={async (text) => {
                  // Saving what was already there is not an edit — no request,
                  // and no "edited" marker for a change nobody made. Compared
                  // as the person saw it: re-encoding an untouched body can
                  // still differ from the stored one (a plain "@Ada" typed
                  // before it was a mention would quietly become one).
                  if (text.trim() !== toEditable(editableBody, directory).trim()) {
                    const body = toWireBody(text, directory).trim();
                    await actions.edit?.(
                      comment.id,
                      excerpt ? selectionCommentBody(excerpt.selection, body) : body,
                    );
                  }
                  stopEditing();
                }}
              />
            </div>
          ) : (
            <CommentBody text={comment.body ?? ""} directory={directory} />
          )}

          {/* Votes on every comment, as the web shows them. Resolve and Reply
           *  on roots only: the server refuses to re-parent a reply, so
           *  offering Reply on one would promise a third level that cannot
           *  exist. */}
          {!editing && (isRoot || hasVotes(comment, actions, directory)) && (
            <div className="mt-1 flex items-center gap-0.5">
              <Votes comment={comment} actions={actions} directory={directory} />
              {isRoot && (
                <>
                  <Action
                    onClick={() => run(() => actions.resolve(comment.id, !resolved))}
                    disabled={busy}
                  >
                    <Check size={10} />
                    {resolved ? "Reopen" : "Resolve"}
                  </Action>
                  {onReply && <Action onClick={onReply}>Reply</Action>}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

/** Whether a comment's vote control has anything to show: votes already cast,
 *  or a reader who may cast one. */
function hasVotes(comment: Comment, actions: CommentActions, directory: OrgDirectory): boolean {
  const votes = comment.votes ?? NO_VOTES;
  const canVote = !!actions.vote && directory.currentUserId !== null && !comment.deletedAt;
  return canVote || votes.up.length + votes.down.length > 0;
}

/**
 * ⇧ n ⇩, the web reader's vote control: two bare arrows and the net score
 * between them, sized like the actions beside them rather than drawn as chips.
 * One vote per person: clicking your own vote takes it back, clicking the
 * other side switches it. Your vote fills its arrow; each arrow's tooltip
 * names who voted that way. Where the reader may not vote, the score shows
 * and nothing is clickable; a comment nobody has voted on, nothing at all.
 */
function Votes({
  comment,
  actions,
  directory,
}: {
  comment: Comment;
  actions: CommentActions;
  directory: OrgDirectory;
}) {
  if (!hasVotes(comment, actions, directory)) return null;
  const votes = comment.votes ?? NO_VOTES;
  const me = directory.currentUserId;
  const current = voteOf(votes, me);
  const canVote = !!actions.vote && me !== null && !comment.deletedAt;
  const total = votes.up.length + votes.down.length;
  const score = votes.up.length - votes.down.length;

  const cast = (side: 1 | -1) => {
    // Drawn at once by the action; a refusal puts it back, and says so here.
    void actions.vote?.(comment.id, nextVote(current, side)).catch((e: unknown) => {
      toast.error(`Couldn't record that vote: ${e instanceof Error ? e.message : String(e)}`);
    });
  };
  const votersOf = (who: readonly string[]) => {
    // Your own name first: it is the one you look for.
    const ordered = me && who.includes(me) ? [me, ...who.filter((id) => id !== me)] : who;
    return nameList(
      ordered.map((id) => (id === me ? "You" : (directory.byId.get(id)?.name ?? "A member"))),
    );
  };

  return (
    <span className="mr-1 flex items-center">
      <VoteArrow
        side={1}
        count={votes.up.length}
        pressed={current === 1}
        voters={votersOf(votes.up)}
        onClick={canVote ? () => cast(1) : undefined}
      />
      {total > 0 && (
        <span
          aria-label={`Score ${score}`}
          className={cn(
            "min-w-3 px-0.5 text-center font-mono text-2xs tabular-nums",
            current === 1
              ? "text-success"
              : current === -1
                ? "text-info"
                : "text-[var(--muted-foreground)]",
          )}
        >
          {score}
        </span>
      )}
      <VoteArrow
        side={-1}
        count={votes.down.length}
        pressed={current === -1}
        voters={votersOf(votes.down)}
        onClick={canVote ? () => cast(-1) : undefined}
      />
    </span>
  );
}

function VoteArrow({
  side,
  count,
  pressed,
  voters,
  onClick,
}: {
  side: 1 | -1;
  count: number;
  pressed: boolean;
  voters: string;
  /** Absent where the reader may only look. */
  onClick?: () => void;
}) {
  const what = side === 1 ? "Upvote" : "Downvote";
  const Icon = side === 1 ? ArrowBigUp : ArrowBigDown;
  const label = count > 0 ? `${what}d by ${voters}` : what;
  const className = cn(
    "flex size-4 items-center justify-center rounded-sm transition-colors",
    pressed ? (side === 1 ? "text-success" : "text-info") : "text-[var(--muted-foreground)]",
    onClick && "cursor-pointer hover:bg-element-hover",
    onClick && !pressed && (side === 1 ? "hover:text-success" : "hover:text-info"),
  );
  const glyph = <Icon size={12} className={cn(pressed && "fill-current")} />;
  if (!onClick) {
    return (
      <span role="img" aria-label={label} title={label} className={className}>
        {glyph}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className={className}
    >
      {glyph}
    </button>
  );
}

/** "A", "A and B", "A, B and C". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A root's inline action. Quiet until the comment is hovered. */
function Action({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1 rounded px-1 py-px text-2xs text-[var(--muted-foreground)] transition-colors hover:bg-element-hover hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** `HH:MM:SS`, matching the timestamps the rest of the Session detail uses. */
function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : formatTime(date, { timeStyle: "medium" });
}
