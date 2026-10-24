// What the Code tab draws under a line: a review thread (its comments, a
// reply box, resolve / unresolve, reactions), a line comment waiting in the
// review in progress, and the box a new line comment is written in.
//
// These render inside the diff viewer's rows, so pointer presses stop here:
// the viewer would otherwise read them as a line selection.

import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  CircleCheck,
  Circle,
  Hammer,
  MessageCircleQuestion,
  MessageSquare,
  Trash2,
} from "lucide-react";

import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";

import { classifyPrError } from "../lib/pr-errors";
import { findingKey } from "../lib/pull-request-logic";
import { prThreadComments } from "../lib/pull-requests-api";
import { usePrReplyMutation, usePrResolveMutation } from "../lib/pull-requests-queries";
import type { PrReviewThread, PrThreadComment } from "../lib/pull-requests-types";
import { readableFailure } from "../lib/use-pull-request-actions";
import type { PendingReviewComment } from "../stores/pull-request-review-store";
import { PullRequestCommentActions } from "./pull-request-comment-actions";
import { usePullRequestScope } from "./pull-request-context";
import { PullRequestMarkdown, TEXTAREA_CLASS } from "./pull-request-markdown";
import { ActorLabel } from "./pull-request-presentation";
import { ReactionBar } from "./pull-request-reactions";

const CARD_CLASS =
  "mx-3 my-2 rounded-lg border border-border bg-background p-3 font-sans text-sm text-foreground shadow-sm";

const stop = (event: React.PointerEvent) => event.stopPropagation();

function isSubmitChord(event: React.KeyboardEvent): boolean {
  return (
    !event.nativeEvent.isComposing &&
    event.key === "Enter" &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** The comments already shown plus a page read since, each once, oldest first. */
function mergeComments(
  shown: readonly PrThreadComment[],
  loaded: readonly PrThreadComment[],
): PrThreadComment[] {
  const seen = new Set(shown.map((c) => c.id));
  return [...shown, ...loaded.filter((c) => !seen.has(c.id))];
}

export function ReviewThreadCard({
  thread,
  canReply,
  canResolve,
  canReact,
}: {
  thread: PrReviewThread;
  canReply: boolean;
  canResolve: boolean;
  canReact: boolean;
}) {
  const { repoPath, number, agent } = usePullRequestScope();
  const fixKey = findingKey({ kind: "thread", thread });
  const replyMutation = usePrReplyMutation(repoPath, number);
  const resolveMutation = usePrResolveMutation(repoPath, number);
  const [expanded, setExpanded] = useState(!thread.isResolved);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState("");
  const sending = useRef(false);
  const [loaded, setLoaded] = useState<{
    threadId: string;
    comments: PrThreadComment[];
    nextCursor: string | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const page = loaded?.threadId === thread.id ? loaded : null;
  const comments = mergeComments(thread.comments, page?.comments ?? []);
  const nextCursor = page ? page.nextCursor : thread.nextCommentsCursor;
  const commentCount = Math.max(thread.commentCount, comments.length);
  const pending = replyMutation.isPending || resolveMutation.isPending;

  const send = () => {
    const body = reply.trim();
    if (body.length === 0 || pending || sending.current) return;
    sending.current = true;
    replyMutation.mutate(
      { threadId: thread.id, body },
      {
        onSuccess: () => {
          setReply("");
          setReplying(false);
          // The write returns no comment: reopen the cursor past what was
          // loaded, so the new reply is reachable without a re-read.
          setLoaded((prev) =>
            prev?.threadId === thread.id
              ? { ...prev, nextCursor: prev.nextCursor ?? thread.nextCommentsCursor }
              : prev,
          );
        },
        onError: (raw) =>
          toast.error("The reply could not be posted", {
            description: readableFailure(classifyPrError(raw), "GitHub refused the reply."),
          }),
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  };

  const toggleResolved = () =>
    resolveMutation.mutate(
      { threadId: thread.id, resolved: !thread.isResolved },
      {
        onError: (raw) =>
          toast.error("The review thread could not be updated", {
            description: readableFailure(classifyPrError(raw), "GitHub refused the change."),
          }),
      },
    );

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await prThreadComments(repoPath, number, thread.id, nextCursor);
      setLoaded((prev) => ({
        threadId: thread.id,
        comments: mergeComments(prev?.threadId === thread.id ? prev.comments : [], next.comments),
        nextCursor: next.nextCursor,
      }));
    } catch {
      toast.error("More comments could not be loaded");
    } finally {
      setLoadingMore(false);
    }
  };

  const StatusIcon = thread.isResolved ? CircleCheck : Circle;
  return (
    <div className={CARD_CLASS} contentEditable={false} onPointerDown={stop}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <StatusIcon
          aria-hidden
          className={cn("size-3.5 shrink-0", thread.isResolved && "text-success")}
        />
        <button
          type="button"
          className="cursor-pointer hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {thread.isResolved ? "Resolved" : "Open"} · {commentCount}{" "}
          {commentCount === 1 ? "comment" : "comments"}
        </button>
        {thread.isOutdated ? <span>Outdated</span> : null}
        {/* An open thread can go to an agent, on the pull request's branch. */}
        {agent?.fixFinding && !thread.isResolved ? (
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={agent.pending !== null}
            onClick={() => agent.fixFinding?.({ kind: "thread", thread })}
          >
            <Hammer aria-hidden className="size-3" />
            {agent.pending === fixKey ? "Preparing…" : "Fix in session"}
          </Button>
        ) : null}
        {canResolve ? (
          <Button
            size="xs"
            variant="ghost"
            className={cn(!(agent?.fixFinding && !thread.isResolved) && "ml-auto")}
            disabled={pending}
            onClick={toggleResolved}
          >
            {resolveMutation.isPending ? "Saving…" : thread.isResolved ? "Unresolve" : "Resolve"}
          </Button>
        ) : null}
      </div>

      {expanded ? (
        <>
          <div className="mt-2 space-y-3">
            {comments.map((comment) => (
              <article key={comment.id} className="group min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <ActorLabel actor={comment.author} />
                  <time
                    dateTime={comment.createdAt}
                    title={new Date(comment.createdAt).toLocaleString()}
                  >
                    {timeAgo(comment.createdAt, { suffix: true })}
                  </time>
                  {comment.editedAt ? <span>edited</span> : null}
                  <ReactionBar
                    className="ml-auto justify-end"
                    reactions={comment.reactions}
                    canReact={canReact}
                    subjectId={comment.id}
                  />
                </div>
                <PullRequestCommentActions
                  className="mt-1"
                  comment={{ ...comment, kind: "review-comment" }}
                >
                  <PullRequestMarkdown className="min-w-0 text-sm" text={comment.body} />
                </PullRequestCommentActions>
              </article>
            ))}
          </div>
          {nextCursor ? (
            <Button
              size="xs"
              variant="ghost"
              className="mt-2"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more comments"}
            </Button>
          ) : null}
          {canReply ? (
            replying ? (
              <div className="mt-2 space-y-2">
                <textarea
                  // oxlint-disable-next-line jsx-a11y/no-autofocus -- Pressing Reply asks for the box; it opens ready to type.
                  autoFocus
                  rows={3}
                  value={reply}
                  disabled={replyMutation.isPending}
                  placeholder="Reply"
                  aria-label="Reply to this review thread"
                  className={TEXTAREA_CLASS}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setReplying(false);
                    } else if (isSubmitChord(event)) {
                      event.preventDefault();
                      if (!event.repeat) send();
                    }
                  }}
                />
                <div className="flex justify-end gap-2">
                  <Button size="xs" variant="ghost" onClick={() => setReplying(false)}>
                    Cancel
                  </Button>
                  <Button size="xs" disabled={pending || reply.trim().length === 0} onClick={send}>
                    {replyMutation.isPending ? "Posting…" : "Reply"}
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="xs" variant="ghost" className="mt-2" onClick={() => setReplying(true)}>
                Reply
              </Button>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** A line comment in the review in progress, sent with the review. */
export function PendingCommentCard({
  comment,
  stale = false,
  onRemove,
}: {
  comment: PendingReviewComment;
  /** Its line is no longer in the diff: GitHub would refuse the review. */
  stale?: boolean;
  onRemove: () => void;
}) {
  return (
    <div className={cn(CARD_CLASS, "border-dashed")} contentEditable={false} onPointerDown={stop}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <MessageSquare aria-hidden className="size-3.5" />
        <span>
          {stale
            ? "Pending, but its line is no longer in the diff: discard it to submit your review"
            : "Pending: sent when you submit your review"}
        </span>
        <IconButton
          size="xs"
          icon={Trash2}
          label="Discard this comment"
          className="ml-auto"
          onClick={onRemove}
        />
      </div>
      <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{comment.body}</p>
    </div>
  );
}

/** The box a new line comment is written in: added to the review in
 *  progress, or posted on its own at once. */
export function DraftCommentCard({
  label,
  initialText = "",
  onTextChange,
  onAddToReview,
  onPostNow,
  onCancel,
  canComment = true,
  onAsk,
}: {
  /** `path:line`, for the box's name. */
  label: string;
  /** What was typed before the tab was left, restored. */
  initialText?: string;
  onTextChange?: (text: string) => void;
  onAddToReview: (body: string) => void;
  /** Settles once the post has; the card stays locked until then. */
  onPostNow: (body: string) => Promise<unknown>;
  onCancel: () => void;
  /** `false` for a reader who may not comment: the box only asks. */
  canComment?: boolean;
  /** "Ask about these lines": the text as a question to an agent session,
   *  with the picked lines attached. Absent, the box only comments. */
  onAsk?: (question: string) => void;
}) {
  const [text, setText] = useState(initialText);
  // The posting state is the card's own: the diff viewer re-renders an
  // annotation only when its item's version changes, so a flag passed down
  // from the tab would never reach it, and a second click would post twice.
  // The ref closes the gap before the state re-renders.
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  const body = text.trim();
  const postNow = () => {
    if (postingRef.current || !body) return;
    postingRef.current = true;
    setPosting(true);
    void onPostNow(body)
      .catch(() => undefined)
      .finally(() => {
        postingRef.current = false;
        setPosting(false);
      });
  };
  const addToReview = () => {
    if (postingRef.current || !body) return;
    onAddToReview(body);
  };
  const ask = () => {
    if (postingRef.current || !onAsk) return;
    onAsk(text);
  };
  const submit = canComment ? addToReview : ask;
  return (
    <div className="px-3 py-2 font-sans" contentEditable={false} onPointerDown={stop}>
      <textarea
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- The reader pressed the gutter to write here.
        autoFocus
        rows={3}
        value={text}
        disabled={posting}
        placeholder={canComment ? "Leave a comment" : "Ask about these lines"}
        aria-label={canComment ? `Comment on ${label}` : `Ask about ${label}`}
        className={TEXTAREA_CLASS}
        onChange={(event) => {
          setText(event.target.value);
          onTextChange?.(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (isSubmitChord(event) && (body || !canComment) && !event.repeat) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-1.5 flex items-center gap-1">
        <span className="mr-auto text-2xs text-muted-foreground">
          {canComment ? "⌘↵ adds to your review" : "⌘↵ asks an agent"}
        </span>
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {onAsk ? (
          <Button
            size="xs"
            variant={canComment ? "ghost" : "default"}
            disabled={posting}
            onClick={ask}
          >
            <MessageCircleQuestion aria-hidden className="size-3" />
            Ask about these lines
          </Button>
        ) : null}
        {canComment ? (
          <>
            <Button size="xs" variant="outline" disabled={!body || posting} onClick={postNow}>
              {posting ? "Posting…" : "Comment now"}
            </Button>
            <Button size="xs" disabled={!body || posting} onClick={addToReview}>
              Add to review
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
