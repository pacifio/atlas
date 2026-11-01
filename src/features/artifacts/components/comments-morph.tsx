/**
 * All the discussion on this Session — the round button at the foot of the
 * reader that grows into a panel.
 *
 * Same CSS morph as {@link ShareMorph} (`.t-morph` in `globals.css`), anchored
 * at the bottom-RIGHT so it grows up and to the left. Its height is fixed
 * rather than measured: a comment list is as long as it is, and a panel that
 * resized itself as you filtered would be the one thing on screen moving while
 * you read it.
 *
 * The badge lives OUTSIDE the morph box, which clips — and steps away while
 * the panel is open, because a count over an open list is answering a question
 * nobody is asking any more.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownRight, MessageSquareMore, Search, X } from "lucide-react";
import { CommenterAvatar, GuestChip, commenterName } from "@/components/commenter-avatar";
import { cn } from "@/lib/utils";
import { useControllableOpen } from "@/lib/use-controllable-open";
import { timeAgo } from "@/lib/time-ago";
import type { SessionDetail as Detail, TimelineEntry } from "../types";
import type { RowComments } from "./session-detail";
import { visibleCount } from "../lib/comments-api";

type Filter = "all" | "open";

/** What a thread is hung off, for the row's `↳` line. */
function anchorLabel(anchorKind: string, anchorId: string, byId: Map<string, TimelineEntry>) {
  if (anchorKind === "session") return "This session";
  const e = byId.get(anchorId);
  if (!e) {
    return anchorKind === "tool_call"
      ? "A tool call"
      : anchorKind === "checkpoint"
        ? "A checkpoint"
        : "An entry";
  }
  if (e.kind === "tool_call") return `Tool call · ${e.toolTitle ?? e.toolName ?? ""}`.trim();
  if (e.kind === "checkpoint") return `Checkpoint · ${e.commitSha?.slice(0, 7) ?? ""}`.trim();
  return e.kind === "prompt" ? "Prompt" : e.kind === "thinking" ? "Thinking" : "Response";
}

export function CommentsMorph({
  detail,
  comments,
  onJump,
  open: openProp,
  onOpenChange,
  anchorY = "bottom",
  inPill = false,
}: {
  detail: Detail;
  comments: RowComments;
  /** Scroll the reader to the entry a thread is hung off. */
  onJump: (anchorId: string) => void;
  /** Owns the open state when given (the overview's Session card opens this
   *  from its own button); otherwise the morph keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Which edge the closed button sits on and the panel grows away from.
   *  "bottom" (default) grows up out of a footer; "top" grows down. */
  anchorY?: "top" | "bottom";
  /** Closed, it is a button in the reader's footer pill (`footer-pill.tsx`),
   *  at the pill's right end. */
  inPill?: boolean;
}) {
  const [open, setOpen] = useControllableOpen(openProp, onOpenChange);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const { directory } = comments;

  const byId = useMemo(
    () => new Map(detail.entries.map((e) => [e.id, e] as const)),
    [detail.entries],
  );

  /** Every root comment on the Session, with its replies. */
  const threads = useMemo(() => {
    const all = [
      ...comments.session.map((c) => ({ c, anchorKind: "session", anchorId: detail.summary.id })),
      ...Object.entries(comments.byAnchor).flatMap(([anchorId, list]) =>
        list.map((c) => ({ c, anchorKind: c.anchorKind as string, anchorId })),
      ),
    ].filter(({ c }) => !c.deletedAt);

    const roots = all.filter(({ c }) => !c.parentId);
    const q = query.trim().toLowerCase();
    return roots
      .filter(({ c }) => (filter === "open" ? !c.resolvedAt : true))
      .map((row) => ({
        ...row,
        replies: all.filter(({ c }) => c.parentId === row.c.id),
      }))
      .filter(({ c, replies }) => {
        if (!q) return true;
        return [c, ...replies.map((r) => r.c)].some(
          (x) =>
            x.body?.toLowerCase().includes(q) ||
            commenterName({ authorId: x.authorId, guestName: x.guestName }, directory)
              .toLowerCase()
              .includes(q),
        );
      })
      .sort((a, b) => Date.parse(b.c.createdAt) - Date.parse(a.c.createdAt));
  }, [comments, detail.summary.id, filter, query, directory]);

  // Every live comment on the Session: the session-level thread plus each
  // anchor's. `visibleCount` counts one bucket, so this sums them.
  const total =
    visibleCount(comments.session) +
    Object.values(comments.byAnchor).reduce((n, bucket) => n + visibleCount(bucket), 0);

  // Dismiss on a click outside or Escape; focus the search as the panel
  // finishes fading in.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => search.current?.focus(), 200);
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={root}
      className={cn(
        "relative z-10",
        inPill && "size-7 shrink-0 [--morph-closed:1.75rem] [--morph-r-closed:0.875rem]",
      )}
    >
      <div
        data-open={open}
        data-anchor-y={anchorY}
        className={cn(
          "t-morph border border-[var(--border)] bg-[var(--popover)]/85 shadow-md backdrop-blur-xl",
          "data-[open=true]:shadow-lg",
          // In a footer pill (`footer-pill.tsx`) the closed box IS one of the
          // pill's buttons: the pill's size, no chrome of its own, the pill's
          // hover. It takes the panel's chrome as it opens, and sits absolute
          // in its slot so growing covers the pill rather than pushing it —
          // `!` because `.t-morph`'s own `position: relative` is unlayered
          // CSS (globals.css) and outranks any utility.
          inPill &&
            "absolute! bottom-0 data-[open=false]:border-transparent data-[open=false]:bg-transparent data-[open=false]:shadow-none data-[open=false]:backdrop-blur-none data-[open=false]:hover:bg-element-hover",
          inPill && "right-0",
          // The width cap leaves the bar's padding, the share button beside
          // it and the gap between them, so the panel never runs past the
          // reader's edge.
          "[--morph-open-h:min(32rem,calc(100svh-10rem))] [--morph-open-w:min(24rem,calc(100cqw-4.75rem))]",
        )}
      >
        {/* The panel's own fill, in the OTHER appearance — white over a dark
            session, dark over a light one — so it reads as a layer laid over
            the record rather than as more of it. Its own `aria-hidden` div so
            the round button does not flash at the panel's colour halfway
            through the morph. */}
        <div aria-hidden data-theme-invert className="t-morph-surface bg-[var(--popover)]" />

        <div
          data-theme-invert
          role="dialog"
          aria-label="Comments"
          inert={!open}
          className="t-morph-menu flex flex-col gap-2.5 p-3 text-foreground"
        >
          <header className="flex items-center justify-between gap-2">
            <div
              role="tablist"
              className="flex w-fit items-center gap-0.5 rounded-full bg-foreground/8 p-0.5 ring-1 ring-foreground/15"
            >
              {(["all", "open"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "h-5.5 shrink-0 cursor-pointer rounded-full px-2.5 text-2xs font-medium capitalize transition-colors duration-fast",
                    filter === f
                      ? "bg-[var(--popover)] text-foreground ring-1 ring-foreground/8"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label="Close comments"
              onClick={() => setOpen(false)}
              className="flex size-8 cursor-pointer items-center justify-center rounded-full text-secondary-foreground ring-1 ring-foreground/20 transition-colors duration-fast hover:bg-element-hover hover:text-foreground"
            >
              <X size={14} />
            </button>
          </header>

          <ul className="-mx-1 min-h-0 flex-1 overflow-y-auto hide-scrollbar">
            {threads.length === 0 ? (
              <li className="px-2 py-10 text-center text-xs text-muted-foreground">
                {query
                  ? "No comments match."
                  : filter === "open"
                    ? "No open threads."
                    : "No comments here yet."}
              </li>
            ) : (
              threads.map(({ c, anchorKind, anchorId, replies }) => {
                const commenter = { authorId: c.authorId, guestName: c.guestName };
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onJump(anchorId);
                      }}
                      className={cn(
                        "flex w-full cursor-pointer flex-col gap-1 rounded-xl px-2 py-2 text-left",
                        "transition-colors duration-fast hover:bg-element-hover",
                        c.resolvedAt && "opacity-55",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <CommenterAvatar commenter={commenter} directory={directory} size={20} />
                        <span className="min-w-0 truncate text-xs font-medium">
                          {commenterName(commenter, directory)}
                        </span>
                        {c.guestName && <GuestChip />}
                        <span className="flex-1" />
                        <span className="shrink-0 font-mono text-3xs text-muted-foreground">
                          {timeAgo(c.createdAt)}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-xs leading-snug text-secondary-foreground">
                        {c.body ?? ""}
                      </span>
                      <span className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
                        <span className="flex min-w-0 items-center gap-1">
                          <CornerDownRight size={11} className="shrink-0" />
                          <span className="truncate">
                            {anchorLabel(anchorKind, anchorId, byId)}
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums">
                          {c.resolvedAt
                            ? "Resolved"
                            : replies.length > 0
                              ? `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`
                              : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          <label className="flex h-9 shrink-0 items-center gap-2 rounded-2xl border border-border-strong bg-[var(--card)] px-3 transition-colors duration-fast focus-within:border-foreground/20">
            <Search size={13} className="shrink-0 text-muted-foreground" />
            <input
              ref={search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search comments…"
              aria-label="Search comments"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
        </div>

        <button
          type="button"
          aria-label={`${total} comments — open all comments`}
          aria-expanded={open}
          onClick={() => setOpen(true)}
          // `-right-px -bottom-px`: the box has a 1px border and positioned
          // children sit inside it, so without this the trigger hangs a pixel
          // up and left of the circle's centre.
          className="t-morph-trigger -right-px -bottom-px flex cursor-pointer items-center justify-center text-muted-foreground transition-colors duration-fast hover:text-foreground"
        >
          <MessageSquareMore size={14} strokeWidth={1.6} />
        </button>
      </div>

      {/* Outside the morph box, which clips: the badge overhangs the button's
          corner and steps away while the panel is open.
 */}
      {total > 0 && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center",
            // ratchet-allow: a count on a saturated red fill needs a fixed light ink. The
            // theme's `destructive-foreground` is the ink for a destructive BUTTON, and in every
            // dark theme here it is black — which rendered an unreadable black-on-red count.
            // White is not a theme choice on this element; it is the only legible value against
            // a fill that is saturated red in every appearance.
            "rounded-full bg-[var(--destructive)] px-1 text-3xs font-semibold tabular-nums text-white",
            "ring-2 ring-[var(--card)] transition-[opacity,scale] duration-fast",
            open ? "scale-50 opacity-0" : "scale-100 opacity-100",
          )}
        >
          {total}
        </span>
      )}
    </div>
  );
}
