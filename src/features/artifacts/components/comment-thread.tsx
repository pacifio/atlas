/**
 * The inline comment thread — a Figma-style popover hung off a timeline node.
 *
 * Inline rather than a side panel, because a comment is *about one row* and a
 * panel makes you hold the anchor in your head while you read it. The thread
 * opens beside the thing it is discussing and closes again.
 *
 * ## Shape
 *
 * A root, its replies indented under a rail, and one composer per thread.
 * **Exactly two levels** — that is the server's rule, not a simplification: it
 * refuses to re-parent a reply, so a deeper tree could never be sent. The UI
 * says so by giving a reply no reply button of its own.
 *
 * ## What is deliberately absent
 *
 * **Offline drafting.** Comments are network-only; there is no local table and
 * nothing queues. The composer keeps your text on failure rather than pretending
 * it sent.
 *
 * **Reactions.** The server has no reactions model on this surface — no table,
 * no route — so the thumbs-up in the reference design has nothing behind it.
 * Resolve and Reply are the two actions that exist.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, CornerDownLeft, Link2, Loader2, MessageSquare, Pencil, Trash2 } from "lucide-react";

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import type { AccountUser, OrgMember } from "@/features/auth/lib/auth-api";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { cn } from "@/lib/utils";

import { toEditable, toWireBody } from "../lib/comment-edit";
import { COMMENT_BODY_MAX, visibleCount, type AnchorKind, type Comment } from "../lib/comments-api";

/** Everything the thread needs to talk to the server, supplied by the panel. */
export interface CommentActions {
  post: (
    anchorKind: AnchorKind,
    anchorId: string,
    body: string,
    parentId: string | null,
  ) => Promise<void>;
  resolve: (commentId: string, resolved: boolean) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
  /**
   * Replace your own comment's body. Optional, like the web's `patch`: a
   * surface that cannot write edits simply draws no Edit.
   */
  edit?: (commentId: string, body: string) => Promise<void>;
  /**
   * Reference this comment in the agent chat composer, so the agent attends
   * to it. Only a surface with a composer to link into supplies it (the live
   * chat); without it the link button is not drawn.
   */
  link?: (comment: Comment) => void;
}

/**
 * Rules and dividers, pulled 30% toward the surface behind them.
 *
 * `--atlas-border-strong` at full strength reads as structure competing with
 * the text; `--border` disappeared against the translucent panel entirely. The
 * same mix the Timeline nav uses for its rail, and for the same reason: a line
 * that only has to say "these are separate" should not be the loudest thing in
 * the popover.
 */
const RULE = "color-mix(in srgb, var(--atlas-border-strong) 70%, var(--background))";

/** Diameter of every face in the thread — comments and both composers. */
const AVATAR_PX = 18;
/** Gap between a face and the text beside it. */
const AVATAR_GAP = 6;
/**
 * Padding shared by the thread blocks and the footer.
 *
 * From constants rather than classes so the two cannot drift: the footer used
 * `BLOCK_PAD_X` on all four sides and ended up visibly roomier than the blocks
 * above it.
 */
const BLOCK_PAD_X = 10;
const BLOCK_PAD_Y = 8;
/**
 * Where a reply sits.
 *
 * Aligned with the parent's *text*, not inset by an arbitrary amount — that
 * alignment is what says "this hangs off the comment above" now that there is
 * no rail drawing the connection.
 */
const REPLY_INDENT = AVATAR_PX + AVATAR_GAP;

/** Faces on the button. Four is a crowd at this size; three reads as a group. */
export const MAX_FACES = 3;
/** Counts past this are a smudge at 10px — say "more" instead of how many. */
export const MAX_COUNT = 9;

/**
 * `OrgMember` in the shape `AccountAvatar` reads.
 *
 * Keyed on `userId`, the human — the avatar's colour is derived from the id it
 * is given, and the membership id would recolour the same person per
 * Organisation.
 */
export function avatarUser(member: OrgMember): AccountUser {
  return {
    id: member.userId,
    name: member.name,
    email: member.email,
    avatarPath: member.avatarPath,
  } as AccountUser;
}

/** Who is in this thread, most recent speaker first, deduplicated. */
export function facesOf(comments: Comment[], directory: OrgDirectory): AccountUser[] {
  const seen = new Set<string>();
  const out: AccountUser[] = [];
  // Newest first: the people still talking are the ones worth showing when
  // only three fit.
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.deletedAt || seen.has(comment.authorId)) continue;
    seen.add(comment.authorId);
    const member = comment.guestName ? null : directory.byId.get(comment.authorId);
    if (member) out.push(avatarUser(member));
    if (out.length === MAX_FACES) break;
  }
  return out;
}

/**
 * The button that opens a thread, and the thread itself.
 *
 * Shows **who is talking** once a discussion exists — a bare count says one
 * happened without saying whose, and a conversation you cannot see without
 * hovering every row is a conversation nobody reads.
 *
 * `bare` drops the pill chrome for a caller that groups this with other
 * controls and draws the surround itself (see `ActionCluster` in
 * `session-detail.tsx`).
 */
export const CommentButton = memo(function CommentButton({
  anchorKind,
  anchorId,
  comments,
  actions,
  directory,
  className,
  bare,
  label = "Comment",
}: {
  anchorKind: AnchorKind;
  anchorId: string;
  comments: Comment[] | undefined;
  actions: CommentActions;
  directory: OrgDirectory;
  className?: string;
  /** Rendered inside a shared surround; draw no border or fill of my own. */
  bare?: boolean;
  label?: string;
}) {
  const count = visibleCount(comments);
  const faces = useMemo(
    () => (count > 0 ? facesOf(comments ?? [], directory) : []),
    [count, comments, directory],
  );

  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label={count > 0 ? `${label} (${count})` : label}
        className={cn(
          "flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full text-[var(--atlas-text-disabled)] transition-all duration-150 hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] focus-visible:opacity-100",
          count > 0 && "text-[var(--secondary-foreground)]",
          // Inside a cluster the surround belongs to the cluster, which also
          // owns when the whole group is visible.
          bare
            ? cn(count > 0 ? "pl-0.5 pr-1.5" : "px-1", className)
            : count > 0
              ? "border border-border bg-card pl-0.5 pr-1.5 opacity-100"
              : cn("px-1 opacity-0", className ?? "group-hover/row:opacity-100"),
        )}
      >
        {count > 0 ? (
          <>
            {/* Overlapped, in reading order: the ring is the row's own surface,
             *  so the stack reads as depth rather than as touching circles. */}
            {faces.length > 0 && (
              <span className="flex shrink-0 items-center -space-x-1.5">
                {faces.map((user) => (
                  <span key={user.id} className="rounded-full ring-1 ring-[var(--card)]">
                    <AccountAvatar user={user} size={14} />
                  </span>
                ))}
              </span>
            )}
            <span className="text-2xs tabular-nums">
              {count > MAX_COUNT ? `${MAX_COUNT}+` : count}
            </span>
          </>
        ) : (
          <MessageSquare size={11} strokeWidth={1.7} />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="isolate z-popover" side="bottom" align="end" sideOffset={6}>
          <Popover.Popup
            className={cn(
              "w-[360px] origin-[var(--transform-origin)] overflow-hidden rounded-xl shadow-md outline-none",
              // Border, translucent fill and blur all on THIS element — the
              // same one the animation transforms. Splitting them across a
              // wrapper isolates the compositing layer and flattens the blur to
              // flat transparency (the note beside the keyframes in
              // globals.css, and what `capture-popover` already does).
              "border border-[var(--atlas-element-active)] bg-[var(--card)]/95 backdrop-blur-2xl",
              // The lit-from-above sheen, as a utility rather than
              // `atlas-vibrant-panel` — that class isolates its layer and would
              // flatten the blur it sits on.
              "atlas-panel-sheen",
              "data-closed:animate-scale-out data-open:animate-scale-in",
              // `body` sets `user-select: none`; a thread you cannot select
              // text in is a thread you cannot quote.
              "select-text",
            )}
          >
            <Thread
              anchorKind={anchorKind}
              anchorId={anchorId}
              comments={comments ?? []}
              actions={actions}
              directory={directory}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});

function Thread({
  anchorKind,
  anchorId,
  comments,
  actions,
  directory,
}: {
  anchorKind: AnchorKind;
  anchorId: string;
  comments: Comment[];
  actions: CommentActions;
  directory: OrgDirectory;
}) {
  /** Which root has its reply box open. One at a time — see `Replying`. */
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  // Roots in server order, each with its replies. One level deep, so this is a
  // partition rather than a tree walk.
  const threads = useMemo(() => {
    const replies = new Map<string, Comment[]>();
    for (const c of comments) {
      if (!c.parentId) continue;
      const bucket = replies.get(c.parentId);
      if (bucket) bucket.push(c);
      else replies.set(c.parentId, [c]);
    }
    return comments
      .filter((c) => !c.parentId)
      .map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
  }, [comments]);

  // An open thread should land on the newest, which is where the conversation
  // actually is — not the top, which is where it started.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [comments.length]);

  return (
    <div className="flex max-h-[380px] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <p
            className="text-xs text-[var(--muted-foreground)]"
            style={{ padding: `${BLOCK_PAD_Y}px ${BLOCK_PAD_X}px` }}
          >
            No comments on this {anchorKind === "session" ? "Session" : "step"} yet.
          </p>
        ) : (
          threads.map(({ root, replies }, i) => (
            <RootThread
              key={root.id}
              root={root}
              replies={replies}
              directory={directory}
              actions={actions}
              divided={i > 0}
              replying={replyingTo === root.id}
              onToggleReply={() => setReplyingTo(replyingTo === root.id ? null : root.id)}
              onPost={async (body) => {
                await actions.post(anchorKind, anchorId, body, root.id);
                setReplyingTo(null);
              }}
            />
          ))
        )}
        <div ref={endRef} />
      </div>

      {/* Starting a new thread, as opposed to replying to one. Pinned below the
       *  scroller so it does not drift as the discussion grows. */}
      <div
        style={{
          padding: `${BLOCK_PAD_Y}px ${BLOCK_PAD_X}px`,
          borderTop: `1px solid ${RULE}`,
        }}
      >
        <Composer
          placeholder={threads.length === 0 ? "Start a discussion" : "Start a new thread…"}
          directory={directory}
          autoFocus={threads.length === 0}
          onSend={(body) => actions.post(anchorKind, anchorId, body, null)}
        />
      </div>
    </div>
  );
}

/**
 * One root comment and everything hanging off it.
 *
 * Replies are indented to line up with the parent's text rather than connected
 * by a rail. The alignment carries the relationship on its own, and a drawn
 * line has to be measured against an avatar it is not a sibling of — which is
 * more machinery than one level of nesting is worth.
 */
function RootThread({
  root,
  replies,
  directory,
  actions,
  divided,
  replying,
  onToggleReply,
  onPost,
}: {
  root: Comment;
  replies: Comment[];
  directory: OrgDirectory;
  actions: CommentActions;
  /** Not the first thread in the popover, so it carries a rule above it. */
  divided: boolean;
  replying: boolean;
  onToggleReply: () => void;
  onPost: (body: string) => Promise<void>;
}) {
  const nested = replies.length > 0 || replying;

  return (
    <div
      style={{
        padding: `${BLOCK_PAD_Y}px ${BLOCK_PAD_X}px`,
        borderTop: divided ? `1px solid ${RULE}` : undefined,
      }}
    >
      <CommentRow
        comment={root}
        directory={directory}
        actions={actions}
        isRoot
        onReply={onToggleReply}
      />

      {nested && (
        <div className="mt-1.5 space-y-1.5" style={{ paddingLeft: REPLY_INDENT }}>
          {replies.map((reply) => (
            <CommentRow
              key={reply.id}
              comment={reply}
              directory={directory}
              actions={actions}
              isRoot={false}
            />
          ))}
          {replying && (
            <Composer placeholder="Reply…" autoFocus directory={directory} onSend={onPost} />
          )}
        </div>
      )}
    </div>
  );
}

const CommentRow = memo(function CommentRow({
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

  if (comment.deletedAt) {
    // The row survives so replies keep their places, and saying so is more
    // honest than a gap where a comment used to be.
    return (
      <p
        className="text-2xs italic text-[var(--atlas-text-disabled)]"
        style={{ paddingLeft: REPLY_INDENT }}
      >
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
        {member ? (
          <span className="mt-px shrink-0">
            <AccountAvatar user={avatarUser(member)} size={AVATAR_PX} />
          </span>
        ) : (
          <span
            className="mt-px shrink-0 rounded-full bg-[var(--atlas-element-selected)]"
            style={{ width: AVATAR_PX, height: AVATAR_PX }}
          />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="min-w-0 truncate text-xs font-medium text-[var(--foreground)]">
              {name}
            </span>
            {comment.guestName && (
              <span className="shrink-0 text-3xs text-[var(--atlas-text-disabled)]">guest</span>
            )}
            <span className="shrink-0 font-mono text-3xs text-[var(--atlas-text-disabled)]">
              {time(comment.createdAt)}
            </span>
            {comment.editedAt && (
              <span className="shrink-0 text-3xs text-[var(--atlas-text-disabled)]">edited</span>
            )}
            <span className="flex-1" />
            {busy && <Loader2 size={10} className="animate-spin text-[var(--muted-foreground)]" />}
            {/* Link first, then delete. Every comment can be linked — it
             *  tells the agent "attend to this one" — so it is not gated on
             *  authorship the way delete is. */}
            {actions.link && !busy && (
              <button
                type="button"
                aria-label="Reference comment in agent chat"
                title="Reference in agent chat"
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
                className="flex shrink-0 cursor-pointer items-center rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition-colors hover:text-[var(--atlas-status-error-foreground)] group-hover/comment:opacity-100"
              >
                <Trash2 size={11} />
              </button>
            )}
          </div>

          {editing && actions.edit ? (
            <div className="mt-1">
              <Composer
                placeholder="Edit comment…"
                directory={directory}
                autoFocus
                ariaLabel="Edit comment"
                initial={toEditable(comment.body ?? "", directory)}
                onCancel={stopEditing}
                onSend={async (text) => {
                  // Saving what was already there is not an edit — no request,
                  // and no "edited" marker for a change nobody made. Compared
                  // as the person saw it: re-encoding an untouched body can
                  // still differ from the stored one (a plain "@Ada" typed
                  // before it was a mention would quietly become one).
                  if (text.trim() !== toEditable(comment.body ?? "", directory).trim()) {
                    await actions.edit?.(comment.id, toWireBody(text, directory).trim());
                  }
                  stopEditing();
                }}
              />
            </div>
          ) : (
            <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-snug text-[var(--secondary-foreground)]">
              <Body text={comment.body ?? ""} directory={directory} />
            </p>
          )}

          {/* Root only. A reply has no actions of its own: the server refuses
           *  to re-parent one, so offering Reply here would promise a third
           *  level that cannot exist. */}
          {isRoot && !editing && (
            <div className="mt-1 flex items-center gap-0.5">
              <Action
                onClick={() => run(() => actions.resolve(comment.id, !resolved))}
                disabled={busy}
              >
                <Check size={10} />
                {resolved ? "Reopen" : "Resolve"}
              </Action>
              {onReply && <Action onClick={onReply}>Reply</Action>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

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
      className="flex cursor-pointer items-center gap-1 rounded px-1 py-px text-2xs text-[var(--muted-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/**
 * A comment body with its mentions drawn as pills.
 *
 * `<@user-id>` is the same syntax team chat uses and the same one the server
 * parses out of the stored body, so the three agree by construction. A split
 * rather than a markdown pass on purpose: a comment is a sentence, and running
 * the full pipeline over every one in a popover costs more than it renders.
 */
const MENTION = /<@([A-Za-z0-9_.:-]{1,128})>/g;

function Body({ text, directory }: { text: string; directory: OrgDirectory }) {
  const parts = useMemo(() => {
    const out: Array<{ text: string; mention: boolean }> = [];
    let last = 0;
    for (const match of text.matchAll(MENTION)) {
      const at = match.index ?? 0;
      if (at > last) out.push({ text: text.slice(last, at), mention: false });
      out.push({ text: match[1], mention: true });
      last = at + match[0].length;
    }
    if (last < text.length) out.push({ text: text.slice(last), mention: false });
    return out;
  }, [text]);

  return (
    <>
      {parts.map((part, i) =>
        part.mention ? (
          <span
            // eslint-disable-next-line react/no-array-index-key
            key={i}
            className="rounded bg-[var(--atlas-element-emphasis)] px-1 text-[var(--foreground)]"
          >
            @{directory.byId.get(part.text)?.name ?? part.text}
          </span>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

function Composer({
  placeholder,
  onSend,
  directory,
  autoFocus,
  initial,
  onCancel,
  ariaLabel,
}: {
  placeholder: string;
  /** The field's accessible name. The placeholder vanishes once there is
   *  text, which an edit always starts with. */
  ariaLabel?: string;
  onSend: (body: string) => Promise<void>;
  directory: OrgDirectory;
  autoFocus?: boolean;
  /** An existing body, for an edit. Its presence is what makes this one. */
  initial?: string;
  /** Escape. Only an edit has something to go back to. */
  onCancel?: () => void;
}) {
  const editing = initial !== undefined;
  const [value, setValue] = useState(initial ?? "");
  const field = useRef<HTMLTextAreaElement | null>(null);
  // An edit opens with the caret after the text, where a correction starts —
  // not before the first word, where a bare focus leaves it.
  useEffect(() => {
    const el = field.current;
    if (!editing || !el) return;
    el.setSelectionRange(el.value.length, el.value.length);
    // Mount only: the caret belongs to the person once they start typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const me = directory.currentUserId ? directory.byId.get(directory.currentUserId) : null;

  const send = useCallback(() => {
    const body = value.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    onSend(body)
      .then(() => setValue(""))
      // The text stays in the box on failure. There is no offline queue, so
      // clearing it would destroy what the developer wrote.
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  }, [value, busy, onSend]);

  const over = value.length > COMMENT_BODY_MAX;

  const ready = value.trim().length > 0 && !busy && !over;

  return (
    <div>
      {/* `items-center`, not `items-start`: at one row the field is 30px and the
       *  face is 18px, so top-aligning them left the avatar sitting visibly
       *  high. The field only grows on Shift+Enter, which is the rare case. */}
      <div className="flex items-center gap-1.5">
        {/* A placeholder rather than nothing when the roster has not resolved
         *  you: the field would otherwise jump left, and the rail measures
         *  against this element. */}
        {/* An edit sits under the comment's own byline, so a second face
         *  would only repeat it. */}
        {editing ? null : me ? (
          <span className="shrink-0">
            <AccountAvatar user={avatarUser(me)} size={AVATAR_PX} />
          </span>
        ) : (
          <span
            className="shrink-0 rounded-full bg-[var(--atlas-element-selected)]"
            style={{ width: AVATAR_PX, height: AVATAR_PX }}
          />
        )}
        {/* `relative`, so the send button can be pinned inside the field's
         *  right edge rather than stealing width from it. */}
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={field}
            value={value}
            autoFocus={autoFocus}
            aria-label={ariaLabel ?? placeholder.replace(/…$/, "")}
            placeholder={placeholder}
            rows={1}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && onCancel) {
                // Leave the edit without closing the popover around it.
                e.preventDefault();
                e.stopPropagation();
                onCancel();
                return;
              }
              // Enter sends, Shift+Enter breaks the line — the chat composer's
              // rule, because this reads as chat.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            // `hide-scrollbar` + `overflow-x-hidden`: the global 8px webkit
            // scrollbar otherwise renders as a strip under a one-row field on
            // any sub-pixel overflow. Vertical scrolling for Shift+Enter text
            // still works, just without a visible bar.
            className="hide-scrollbar min-w-0 w-full resize-none overflow-x-hidden break-words rounded-lg border border-border bg-panel-input py-1.5 pl-2 pr-8 text-xs text-[var(--foreground)] outline-none transition-colors placeholder:text-[var(--muted-foreground)] focus:border-border-strong"
          />
          {/* The agent composer's squircle send, at this surface's scale, and
           *  pinned so it does not ride down as the field grows. It carries the
           *  return glyph rather than an arrow because Enter is what actually
           *  sends here — the button is the discoverable form of the shortcut,
           *  not a second way to do it. */}
          <button
            type="button"
            aria-label={editing ? "Save comment" : "Send comment"}
            disabled={!ready}
            onClick={send}
            className={cn(
              "absolute right-[5px] top-[5px] flex size-5 items-center justify-center rounded-md border transition-colors",
              ready
                ? "cursor-pointer border-transparent text-[var(--foreground)] hover:border-[var(--border)] hover:bg-[var(--atlas-element-hover)]"
                : "cursor-not-allowed border-transparent text-[var(--atlas-text-disabled)]",
            )}
          >
            {busy ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <CornerDownLeft size={11} strokeWidth={2.25} />
            )}
          </button>
        </div>
      </div>
      {over && (
        <p className="mt-1 text-3xs text-[var(--atlas-status-error-foreground)]">
          {value.length.toLocaleString()} / {COMMENT_BODY_MAX.toLocaleString()} characters
        </p>
      )}
      {error && (
        <p className="mt-1 text-3xs text-[var(--atlas-status-error-foreground)]">{error}</p>
      )}
    </div>
  );
}

/** `HH:MM:SS`, matching the timestamps the rest of the Session detail uses. */
function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}
