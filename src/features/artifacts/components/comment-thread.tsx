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
 *
 * This module is the button and its popover; the thread inside it is drawn by
 * the views under `views/`.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { MessageSquare } from "lucide-react";

import { CommenterAvatar, type Commenter } from "@/components/commenter-avatar";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { cn } from "@/lib/utils";

import { visibleCount, type AnchorKind, type Comment } from "../lib/comments-api";
import { Thread } from "./views/comment-thread-view";

export { avatarUser } from "../lib/avatar-user";
export { CommentBody } from "./views/comment-composer-view";

/** Everything the thread needs to talk to the server, supplied by the panel. */
export interface CommentActions {
  post: (
    anchorKind: AnchorKind,
    anchorId: string,
    body: string,
    parentId: string | null,
  ) => Promise<void>;
  resolve: (commentId: string, resolved: boolean) => Promise<void>;
  /**
   * Vote: `1` up, `-1` down, `0` to take it back. Optional — a surface that
   * cannot vote still shows the score, with nothing to click.
   */
  vote?: (commentId: string, value: 1 | -1 | 0) => Promise<void>;
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

/** Faces on the button. Four is a crowd at this size; three reads as a group. */
export const MAX_FACES = 3;
/** Counts past this are a smudge at 10px — say "more" instead of how many. */
export const MAX_COUNT = 9;

/** What Base UI would focus first in an opened thread. */
const FIRST_TABBABLE =
  'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Who is in this thread, most recent speaker first, deduplicated.
 *
 * Guests included. They used to be dropped — a guest is not in the roster, so
 * there was no `AccountUser` to push — and a thread a guest had been talking
 * in showed a bare count with no faces at all. They have art instead of a
 * photo (`CommenterAvatar`), which is a face like any other here.
 */
export function facesOf(comments: Comment[], directory: OrgDirectory): Commenter[] {
  const seen = new Set<string>();
  const out: Commenter[] = [];
  // Newest first: the people still talking are the ones worth showing when
  // only three fit.
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.deletedAt || seen.has(comment.authorId)) continue;
    seen.add(comment.authorId);
    const known = comment.guestName !== null || directory.byId.has(comment.authorId);
    if (known) out.push({ authorId: comment.authorId, guestName: comment.guestName });
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
  showLabel = false,
  selectedText,
  onOpenChange,
  openSignal,
  collisionBoundary,
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
  showLabel?: boolean;
  /** Persist this exact excerpt on a new root comment, still anchored to its message. */
  selectedText?: string;
  onOpenChange?: (open: boolean) => void;
  /**
   * Bump to open this thread from elsewhere — the comments panel jumping to
   * the entry a remark is hung off.
   *
   * A changing NUMBER rather than a boolean, so asking twice for the same
   * thread works: a boolean that is already `true` is not a new request, and
   * clicking the same comment again after closing the popover would do
   * nothing.
   */
  openSignal?: number;
  collisionBoundary?: HTMLElement;
}) {
  const count = visibleCount(comments);
  const faces = useMemo(
    () => (count > 0 ? facesOf(comments ?? [], directory) : []),
    [count, comments, directory],
  );

  // Controlled, so `openSignal` can open it. The popover still owns every
  // other way it opens and closes — the trigger, Escape, a click outside —
  // through `onOpenChange`.
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  // Base UI's own first focus scrolls to its target, and the popup gets that
  // focus before it is positioned: portalled to the end of `body`, it can
  // still be thousands of pixels below the fold. `overflow: hidden` on the
  // root stops the user scrolling, not script, so a jump from the comments
  // panel scrolled the document itself and the whole app slid out of the
  // window until something scrolled it back. Same target as the default
  // (first tabbable, or the popup itself on touch), minus the scroll.
  const popupRef = useRef<HTMLDivElement | null>(null);
  const focusWithoutScrolling = useCallback((openType: string) => {
    const popup = popupRef.current;
    if (!popup) return true;
    const first = openType === "touch" ? null : popup.querySelector<HTMLElement>(FIRST_TABBABLE);
    (first ?? popup).focus({ preventScroll: true });
    return false;
  }, []);

  return (
    <Popover.Root open={open} onOpenChange={changeOpen}>
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
        {showLabel ? (
          <>
            {/* 12 beside a label: the labelled form sits next to other
                labelled buttons (the selection toolbar's Cite), whose icons
                are 12 — an 11 beside them read as a smaller button. */}
            <MessageSquare size={12} strokeWidth={1.7} />
            <span className="text-xs">{label}</span>
            {count > 0 && (
              <span className="text-2xs tabular-nums">
                {count > MAX_COUNT ? `${MAX_COUNT}+` : count}
              </span>
            )}
          </>
        ) : count > 0 ? (
          <>
            {/* Overlapped, in reading order: the ring is the row's own surface,
             *  so the stack reads as depth rather than as touching circles. */}
            {faces.length > 0 && (
              <span className="flex shrink-0 items-center -space-x-1.5">
                {faces.map((face) => (
                  <span key={face.authorId} className="rounded-full ring-1 ring-[var(--card)]">
                    <CommenterAvatar commenter={face} directory={directory} size={14} />
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
        <Popover.Positioner
          className="isolate z-popover"
          side="bottom"
          align="end"
          sideOffset={6}
          collisionBoundary={collisionBoundary}
        >
          <Popover.Popup
            ref={popupRef}
            initialFocus={focusWithoutScrolling}
            className={cn(
              "w-[360px] max-w-(--available-width) max-h-(--available-height) origin-[var(--transform-origin)] overflow-hidden rounded-xl shadow-md outline-none",
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
              selectedText={selectedText}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
