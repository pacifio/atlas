/**
 * The comment affordances inside a turn's fold, when its session is shared.
 * (Prompts and responses carry theirs in their action bars — see
 * `user-row-actions.tsx` and `prose-row-actions.tsx`.)
 *
 * Every component here reads `chat-comments-store` through a narrow selector
 * and renders NOTHING when the tab has no cloud target or the row was never
 * captured — so an unshared chat pays no DOM for any of this. The thread
 * popover, faces and composer are the Timeline's `CommentButton`, unchanged.
 *
 * Nothing here transitions. The transcript's hover reveals snap (see
 * `user-row-actions.tsx`); `transition-none` overrides the button's own.
 */

import { memo, useMemo } from "react";

import { CommenterAvatar } from "@/components/commenter-avatar";
import { CommentButton, facesOf } from "@/features/artifacts/components/comment-thread";
import { visibleCount, type Comment } from "@/features/artifacts/lib/comments-api";
import { cn } from "@/lib/utils";

import {
  tabCommentsFor,
  useAnchorHit,
  useChatCommentsStore,
  useCommentActions,
  useCommentBucket,
  useCommentDirectory,
  useKeysCommentCount,
  useThreadOpenSignal,
} from "../stores/chat-comments-store";

/** Does this thinking or tool row carry a discussion? A boolean, so the row
 *  only re-renders when the answer flips. */
export function useRowHasComments(tabId: string, chatKey: string): boolean {
  return useChatCommentsStore((s) => visibleCount(s.byTab[tabId]?.byChatKey[chatKey]) > 0);
}

/** The same question for a folded run of calls: does anything inside it carry a
 *  discussion? What decides whether the group line makes room for a pill. */
export function useGroupHasComments(tabId: string, chatKeys: readonly string[]): boolean {
  return useChatCommentsStore((s) => {
    const tab = s.byTab[tabId];
    if (!tab) return false;
    for (const key of chatKeys) {
      if (visibleCount(tab.byChatKey[key]) > 0) return true;
    }
    return false;
  });
}

/** The pill on a thinking or tool row that already has a thread. Rendered
 *  only then — inside a fold, an empty "Comment" glyph per line is noise. */
export const RowCommentPill = memo(function RowCommentPill({
  tabId,
  chatKey,
}: {
  tabId: string;
  chatKey: string;
}) {
  const hit = useAnchorHit(tabId, chatKey);
  const bucket = useCommentBucket(tabId, chatKey);
  const actions = useCommentActions(tabId);
  const directory = useCommentDirectory(tabId);
  const openSignal = useThreadOpenSignal(tabId, hit?.rowId);
  if (!hit || !actions || !directory || visibleCount(bucket) === 0) return null;
  return (
    <CommentButton
      className="ml-auto transition-none"
      openSignal={openSignal}
      anchorKind={hit.anchorKind}
      anchorId={hit.rowId}
      comments={bucket}
      actions={actions}
      directory={directory}
    />
  );
});

/**
 * A folded tool sequence's summary of the threads inside it: faces and a count
 * over the calls the fold holds. Clicking opens the fold, where the call that
 * was discussed carries its own pill.
 *
 * It sits HERE rather than on the turn's "Worked" header, which is where it
 * started: that header is the first line of an assistant turn, directly under
 * the prompt's own action bar, and a pill on it read as part of that bar. The
 * indicator belongs on the fold that actually contains the comment.
 *
 * Renders nothing at zero, so an undiscussed sequence pays no DOM for it.
 */
export const GroupCommentPill = memo(function GroupCommentPill({
  tabId,
  chatKeys,
  onOpen,
}: {
  tabId: string;
  /** The tool call ids inside the fold, in the order they ran. */
  chatKeys: readonly string[];
  onOpen: () => void;
}) {
  const count = useKeysCommentCount(tabId, chatKeys);
  const directory = useCommentDirectory(tabId);
  // The keys arrive as a fresh array each projection, so the memo is keyed by
  // their contents rather than by the array's identity.
  const keysKey = chatKeys.join("\u0000");
  const faces = useMemo(() => {
    if (count === 0 || !directory) return [];
    const tab = tabCommentsFor(useChatCommentsStore.getState(), tabId);
    const all: Comment[] = [];
    for (const key of keysKey ? keysKey.split("\u0000") : []) {
      const bucket = tab.byChatKey[key];
      if (bucket) all.push(...bucket);
    }
    return facesOf(all, directory);
  }, [count, directory, tabId, keysKey]);
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${count} ${count === 1 ? "comment" : "comments"} on these tool calls`}
      className={cn(
        "ml-auto flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border bg-card pl-0.5 pr-1.5",
        "text-[var(--secondary-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]",
      )}
    >
      {faces.length > 0 && (
        <span className="flex shrink-0 items-center -space-x-1.5">
          {faces.map((face) => (
            <span key={face.authorId} className="rounded-full ring-1 ring-[var(--card)]">
              <CommenterAvatar commenter={face} directory={directory} size={14} />
            </span>
          ))}
        </span>
      )}
      <span className="text-2xs tabular-nums">{count > 9 ? "9+" : count}</span>
    </button>
  );
});
