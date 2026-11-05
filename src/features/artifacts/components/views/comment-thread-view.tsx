// The thread inside a comment popover: its roots, their replies, and the
// composer that starts a new one. Props only; the actions come from the
// surface that hosts the button.

import { useEffect, useMemo, useRef } from "react";

import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";

import { selectionCommentBody } from "../../lib/selection-comment";
import type { AnchorKind, Comment } from "../../lib/session-detail-context";
import type { CommentActions } from "../comment-thread";
import { Composer, SelectionExcerpt } from "./comment-composer-view";
import { commentAnchorKey, useCommentAnchorState } from "../../lib/comment-anchor-context";
import { CommentRow } from "./comment-row-view";
import { BLOCK_PAD_X, BLOCK_PAD_Y, REPLY_INDENT, RULE } from "./comment-thread-styles";

export function Thread({
  anchorKind,
  anchorId,
  comments,
  actions,
  directory,
  selectedText,
}: {
  anchorKind: AnchorKind;
  anchorId: string;
  comments: Comment[];
  actions: CommentActions;
  directory: OrgDirectory;
  selectedText?: string;
}) {
  // Which root has its reply box open (one at a time — see `Replying`), and
  // the drafts below, outlive the row (`CommentAnchorProvider`). A passage
  // comment is transient: its state is local.
  const anchor = selectedText === undefined ? `${anchorKind}:${anchorId}` : null;
  const [replyingTo, setReplyingTo] = useCommentAnchorState<string | null>(
    anchor && commentAnchorKey.replying(anchor),
    null,
  );

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
  // actually is — not the top, which is where it started. The list scrolls
  // itself, in the next frame: `scrollIntoView` also scrolls every ancestor
  // (the popup mounts unpositioned, far down `body`) and forced a synchronous
  // style recalc of the whole app as the popover opened — ~40ms of the open on
  // a long thread, more on longer ones.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [comments.length]);

  return (
    <div className="flex max-h-[min(380px,var(--available-height))] flex-col">
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
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
              draftKey={anchor && commentAnchorKey.replyDraft(anchor, root.id)}
              onPost={async (body) => {
                await actions.post(anchorKind, anchorId, body, root.id);
                setReplyingTo(null);
              }}
            />
          ))
        )}
      </div>

      {/* Starting a new thread, as opposed to replying to one. Pinned below the
       *  scroller so it does not drift as the discussion grows. */}
      <div
        style={{
          padding: `${BLOCK_PAD_Y}px ${BLOCK_PAD_X}px`,
          borderTop: `1px solid ${RULE}`,
        }}
      >
        {selectedText !== undefined && <SelectionExcerpt text={selectedText} />}
        <Composer
          placeholder={
            selectedText !== undefined
              ? "Comment on this passage…"
              : threads.length === 0
                ? "Start a discussion"
                : "Start a new thread…"
          }
          directory={directory}
          draftKey={anchor && commentAnchorKey.rootDraft(anchor)}
          autoFocus={selectedText !== undefined || threads.length === 0}
          bodyPrefixLength={
            selectedText === undefined ? 0 : selectionCommentBody(selectedText, "").length
          }
          onSend={(body) =>
            actions.post(
              anchorKind,
              anchorId,
              selectedText === undefined ? body : selectionCommentBody(selectedText, body),
              null,
            )
          }
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
  draftKey,
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
  /** Where the reply's unsent text is remembered; `null` keeps it local. */
  draftKey: string | null;
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
            <Composer
              placeholder="Reply…"
              autoFocus
              directory={directory}
              draftKey={draftKey}
              onSend={onPost}
            />
          )}
        </div>
      )}
    </div>
  );
}
