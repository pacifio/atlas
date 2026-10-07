/**
 * Every discussion in the open Session, in one list.
 *
 * The per-node button works once you have found the node — but finding it is
 * the problem this solves. A Session runs to hundreds of entries and a thread
 * announces itself only as a badge on a row you happen to scroll past, so a
 * teammate's comment is discovered by luck. Figma answers the same question
 * with a panel listing every thread in the file; this is that, scoped to one
 * Session.
 *
 * Clicking a thread navigates to the node it hangs off. That reuses the
 * transcript's existing jump machinery (`JUMP_EVENT`) rather than reaching into
 * it: a comment's `anchorId` *is* an entry's `rowId`, so the panel only has to
 * name the id.
 *
 * ## What is deliberately not here
 *
 * **Unread state.** The reference marks unread threads with a dot. Nothing
 * backs that: comment rows carry no read-tracking, and the `read_at` that does
 * exist belongs to `/inbox`, a surface the desktop has no client for. A dot
 * that is always on, or always off, is worse than no dot.
 *
 * **Replying.** The thread popover on the node owns writing; this owns finding.
 * Two composers for one thread is two places for a draft to be lost.
 */

import { memo, useMemo, useState } from "react";
import { Check, CornerDownRight, Filter, MessageSquare, Search, X } from "lucide-react";

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import type { OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { Hint } from "@/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

import {
  buildThreads,
  DEFAULT_THREAD_FILTERS,
  filterThreads,
  threadAuthors,
  threadTally,
  type CommentThread,
  type ThreadFilters,
} from "../lib/comment-threads";
import type { EntryKind, SessionDetail as Detail } from "../types";
import { avatarUser } from "./comment-thread";
import type { RowComments } from "./session-detail";
import { JUMP_EVENT, type JumpDetail } from "./session-chat-message";

/** Navigate the transcript to a thread's anchor. */
function jumpToAnchor(entryId: string): void {
  window.dispatchEvent(new CustomEvent<JumpDetail>(JUMP_EVENT, { detail: { entryId } }));
}

/** What the panel needs to know about a commentable row: its place in the
 *  transcript (array order) and what to call it. */
export interface PanelAnchor {
  id: string;
  kind: EntryKind;
  toolName: string | null;
}

/** The Timeline's panel: anchors are the open Session's entries. */
export function SessionCommentsPanel({
  detail,
  comments,
  onClose,
}: {
  detail: Detail;
  comments: RowComments;
  onClose: () => void;
}) {
  const anchors = useMemo<PanelAnchor[]>(
    () => detail.entries.map((e) => ({ id: e.id, kind: e.kind, toolName: e.toolName ?? null })),
    [detail.entries],
  );
  return (
    <CommentsPanelBase
      anchors={anchors}
      comments={comments}
      onJump={jumpToAnchor}
      onClose={onClose}
    />
  );
}

/**
 * The panel itself, over any transcript that can name its rows. The live chat
 * feeds it the captured rows it has matched and its own jump.
 */
export function CommentsPanelBase({
  anchors,
  comments,
  onJump,
  onClose,
}: {
  anchors: PanelAnchor[];
  comments: RowComments;
  onJump: (anchorId: string) => void;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<ThreadFilters>(DEFAULT_THREAD_FILTERS);
  const { directory } = comments;

  const threads = useMemo(
    () => buildThreads(comments.byAnchor, comments.session, anchors),
    [comments.byAnchor, comments.session, anchors],
  );
  const shown = useMemo(
    () => filterThreads(threads, filters, directory),
    [threads, filters, directory],
  );
  const authors = useMemo(() => threadAuthors(threads), [threads]);

  // What a node is, for the row's label. Built once rather than searched per
  // row: a Session can carry hundreds of entries and dozens of threads.
  const entryById = useMemo(
    () => new Map(anchors.map((anchor) => [anchor.id, anchor] as const)),
    [anchors],
  );

  const narrowed = filters.query.trim() !== "" || filters.authorId !== null || filters.showResolved;
  const resolvedCount = threads.filter((t) => t.resolved).length;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--background)]">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] pl-3 pr-2">
        <MessageSquare size={13} className="shrink-0 text-[var(--muted-foreground)]" />
        <span className="text-xs font-medium text-[var(--foreground)]">Comments</span>
        <span className="font-mono text-2xs text-[var(--atlas-text-disabled)]">
          {shown.length}
          {narrowed && threads.length !== shown.length && ` / ${threads.length}`}
        </span>
        <div className="flex-1" />
        <FilterMenu
          filters={filters}
          setFilters={setFilters}
          authors={authors}
          directory={directory}
          resolvedCount={resolvedCount}
        />
        <Hint label="Close comments">
          <button
            type="button"
            onClick={onClose}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
          >
            <X size={14} />
          </button>
        </Hint>
      </header>

      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <Search size={12} className="shrink-0 text-[var(--muted-foreground)]" />
        <input
          value={filters.query}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          onKeyDown={(e) => {
            // First Escape clears the search; only an empty box lets it
            // through to whatever hosts the panel (which closes on it).
            if (e.key === "Escape" && filters.query) {
              e.preventDefault();
              setFilters((f) => ({ ...f, query: "" }));
            }
          }}
          placeholder="Search comments…"
          spellCheck={false}
          aria-label="Search comments"
          className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
        />
        {filters.query && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setFilters((f) => ({ ...f, query: "" }))}
            className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
          >
            <X size={12} />
          </button>
        )}
      </div>

      <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <Empty
            hasAny={threads.length > 0}
            narrowed={narrowed}
            onClear={() => setFilters(DEFAULT_THREAD_FILTERS)}
          />
        ) : (
          shown.map((thread) => (
            <ThreadRow
              key={thread.anchorId}
              thread={thread}
              directory={directory}
              label={nodeLabel(thread, entryById)}
              onJump={onJump}
            />
          ))
        )}
      </div>
    </div>
  );
}

/** What the thread is attached to, in the transcript's own words. */
function nodeLabel(thread: CommentThread, entryById: Map<string, PanelAnchor>): string {
  if (thread.anchorKind === "session") return "This session";
  const entry = entryById.get(thread.anchorId);
  if (!entry) return "A step";
  switch (entry.kind) {
    case "prompt":
      return "Prompt";
    case "response":
      return "Response";
    case "thinking":
      return "Thinking";
    case "checkpoint":
      return "Checkpoint";
    case "tool_call":
      return entry.toolName ?? "Tool call";
  }
}

const ThreadRow = memo(function ThreadRow({
  thread,
  directory,
  label,
  onJump,
}: {
  thread: CommentThread;
  directory: OrgDirectory;
  label: string;
  onJump: (anchorId: string) => void;
}) {
  const tally = threadTally(thread);
  const author = directory.byId.get(thread.root.authorId) ?? null;
  const name = thread.root.guestName ?? author?.name ?? "A member";
  // The faces of everyone in the thread, not just the opener — the row is a
  // conversation, and who is in it is what makes it worth opening.
  const faces = thread.authorIds
    .map((id) => directory.byId.get(id))
    .filter((member): member is NonNullable<typeof member> => member !== undefined);

  return (
    <button
      type="button"
      onClick={() => onJump(thread.anchorId)}
      className={cn(
        "flex w-full cursor-pointer flex-col items-start gap-1 border-b border-[var(--border)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--atlas-element-hover)]",
        // Resolved is done, not gone: still listed when asked for, but it
        // should not compete with the threads that still need an answer.
        thread.resolved && "opacity-55",
      )}
    >
      {/* Who and when. The name sits beside the faces because the row is a
       *  conversation and the first thing you scan for is whose it is. */}
      <span className="flex w-full min-w-0 items-center gap-1.5">
        {faces.length > 0 && (
          <span className="flex shrink-0 items-center -space-x-1.5">
            {faces.slice(0, 3).map((member) => (
              <span key={member.userId} className="rounded-full ring-1 ring-[var(--background)]">
                <AccountAvatar user={avatarUser(member)} size={14} />
              </span>
            ))}
          </span>
        )}
        <span className="min-w-0 truncate text-2xs font-medium text-[var(--foreground)]">
          {name}
        </span>
        <span className="flex-1" />
        {thread.resolved && (
          <Check size={10} className="shrink-0 text-[var(--atlas-status-success-foreground)]" />
        )}
        <span className="shrink-0 font-mono text-3xs text-[var(--atlas-text-disabled)]">
          {timeAgo(thread.lastActivityAt, { suffix: true })}
        </span>
      </span>

      {/* The comment itself, unprefixed — the byline above already said who. */}
      <span className="line-clamp-2 w-full text-xs leading-snug text-[var(--secondary-foreground)]">
        {thread.root.deletedAt ? (
          <span className="italic text-[var(--atlas-text-disabled)]">deleted this comment</span>
        ) : (
          // Mentions are stored as `<@user-id>`; the preview names them, as
          // the thread itself does.
          (thread.root.body ?? "").replace(
            /<@([A-Za-z0-9_.:-]{1,128})>/g,
            (_, id: string) => `@${directory.byId.get(id)?.name ?? id}`,
          )
        )}
      </span>

      {/* What it is attached to, and how big the discussion got. The anchor is
       *  the footnote rather than the headline: it tells you where you will land
       *  once you have decided the comment is worth landing on. */}
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-[var(--muted-foreground)]">
        <span className="flex min-w-0 items-center gap-1">
          {/* The glyph says this line points *somewhere* — the row is a link to
           *  a node, and the anchor kind alone reads as a label rather than a
           *  destination. */}
          <CornerDownRight size={10} className="shrink-0 text-[var(--atlas-text-disabled)]" />
          <span className="min-w-0 truncate">{label}</span>
        </span>
        {/* Top-level comments and replies apart: a second comment on the same
         *  node is not a reply to the first. Silent for a lone comment. */}
        {(tally.comments > 1 || tally.replies > 0) && (
          <span className="ml-auto shrink-0 tabular-nums">
            {tally.comments} {tally.comments === 1 ? "comment" : "comments"}
            {tally.replies > 0 && (
              <>
                {" · "}
                {tally.replies} {tally.replies === 1 ? "reply" : "replies"}
              </>
            )}
          </span>
        )}
      </span>
    </button>
  );
});

function FilterMenu({
  filters,
  setFilters,
  authors,
  directory,
  resolvedCount,
}: {
  filters: ThreadFilters;
  setFilters: React.Dispatch<React.SetStateAction<ThreadFilters>>;
  authors: string[];
  directory: OrgDirectory;
  resolvedCount: number;
}) {
  const active = filters.authorId !== null || filters.showResolved;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Filter comments"
        className={cn(
          "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded transition-colors hover:bg-[var(--atlas-element-hover)]",
          active
            ? "bg-[var(--atlas-element-active)] text-[var(--foreground)]"
            : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
        )}
      >
        <Filter size={13} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuItem onClick={() => setFilters((f) => ({ ...f, sort: "newest" }))}>
          <Tick on={filters.sort === "newest"} />
          Newest first
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setFilters((f) => ({ ...f, sort: "oldest" }))}>
          <Tick on={filters.sort === "oldest"} />
          Oldest first
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onClick={() => setFilters((f) => ({ ...f, showResolved: !f.showResolved }))}
        >
          <Tick on={filters.showResolved} />
          Show resolved
          {resolvedCount > 0 && (
            <span className="ml-auto pl-2 font-mono text-2xs text-[var(--atlas-text-disabled)]">
              {resolvedCount}
            </span>
          )}
        </DropdownMenuItem>

        {authors.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setFilters((f) => ({ ...f, authorId: null }))}>
              <Tick on={filters.authorId === null} />
              Everyone
            </DropdownMenuItem>
            {authors.map((id) => {
              const member = directory.byId.get(id);
              return (
                <DropdownMenuItem
                  key={id}
                  onClick={() =>
                    setFilters((f) => ({ ...f, authorId: f.authorId === id ? null : id }))
                  }
                >
                  <Tick on={filters.authorId === id} />
                  {/* An id nobody can resolve is still someone who commented —
                   *  offering them as a filter is more useful than hiding the
                   *  option and pretending their threads are unauthored. */}
                  {member ? member.name : "A member"}
                </DropdownMenuItem>
              );
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The menu's checkmark column, kept a fixed width so labels line up. */
function Tick({ on }: { on: boolean }) {
  return <Check size={12} className={cn("shrink-0", on ? "opacity-100" : "opacity-0")} />;
}

function Empty({
  hasAny,
  narrowed,
  onClear,
}: {
  hasAny: boolean;
  narrowed: boolean;
  onClear: () => void;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-xs text-[var(--muted-foreground)]">
        {hasAny ? "No comments match these filters." : "No comments on this session yet."}
      </p>
      {hasAny && narrowed && (
        <button
          type="button"
          onClick={onClear}
          className="mt-2 cursor-pointer text-2xs text-[var(--secondary-foreground)] underline underline-offset-2 transition-colors hover:text-[var(--foreground)]"
        >
          Clear filters
        </button>
      )}
      {!hasAny && (
        <p className="mt-1.5 text-2xs text-[var(--atlas-text-disabled)]">
          Comment on any step from its row in the transcript.
        </p>
      )}
    </div>
  );
}
