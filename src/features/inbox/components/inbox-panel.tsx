// The Organisation's inbox — the web app's /inbox, on the desktop: every time
// someone mentioned you, replied to you, or commented on a Session you
// recorded, in the active synced Organisation, newest first and grouped by
// day. A row opens that Session on the Timeline at the comment's thread.
//
// The bar's actions (`DestinationActions`) are the web's: All / Unread /
// Mentions, and Mark all read. Opening a row marks it read; opening the page
// does not. Nothing pushes the inbox, so the page reads on open and on a
// filter change, and the sidebar's dot polls (`inbox-store.ts`).
//
// Names and faces come from the Organisation's directory: the server sends a
// member's id only (a guest's name is on the row).

import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  AtSign,
  CheckCheck,
  ChevronRight,
  CornerDownRight,
  Inbox as InboxIcon,
  MessageSquare,
  type LucideIcon,
} from "lucide-react";

import { CommenterAvatar, type Commenter } from "@/components/commenter-avatar";
import { useArtifactsStore } from "@/features/artifacts/stores/artifacts-store";
import { ProjectMark } from "@/features/artifacts/components/session-row";
import { TimelineCalendar, type CalendarItem } from "@tryatlas/design/timeline-calendar";
import { dayHeading, startOfDay } from "@/features/artifacts/lib/board";
import { DestinationActions } from "@/features/layout/components/destination-actions";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useOrgDirectory, type OrgDirectory } from "@/features/organisations/lib/use-org-directory";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { errInfo } from "@/features/chat/lib/agent-signin";
import { formatFullTimestamp } from "@/lib/format-time";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { GlassIconButton } from "@/features/sidebar/components/glass-icon-button";

import { inbox, type InboxEntry, type InboxFilter, type InboxKind } from "../lib/inbox-api";
import { useInboxStore } from "../stores/inbox-store";
import { Button, HintGroup, HintItem, Segmented } from "@tryatlas/design";

const KIND_ICON: Record<InboxKind, LucideIcon> = {
  artifact_mention: AtSign,
  artifact_reply: CornerDownRight,
  artifact_session_comment: MessageSquare,
};

const KIND_VERB: Record<InboxKind, string> = {
  artifact_mention: "mentioned you on",
  artifact_reply: "replied to you on",
  artifact_session_comment: "commented on your session",
};

const FILTERS = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "mentions", label: "Mentions" },
] as const;

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; entries: InboxEntry[]; cursor: string | null };

export function InboxPanel() {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  const [marking, setMarking] = useState(false);
  const unread = useInboxStore.use.unread();
  const { setUnread, decrement } = useInboxStore.use.actions();
  const directory = useOrgDirectory();
  // The server Organisation: a switch reads its inbox, from All.
  const orgId = useOrgStore(
    (s) => s.organisations.find((o) => o.id === s.activeOrganisationId)?.remoteId ?? null,
  );
  /** Only the newest read may write: a filter flicked twice must not show
   *  the first one's page. */
  const seq = useRef(0);

  const read = useCallback(
    (which: InboxFilter) => {
      const mine = ++seq.current;
      setLoad({ state: "loading" });
      setMore("idle");
      inbox
        .page(which)
        .then((page) => {
          if (mine !== seq.current) return;
          setLoad({ state: "ready", entries: page.entries, cursor: page.nextCursor });
          setUnread(page.unread);
        })
        .catch((e) => {
          if (mine !== seq.current) return;
          setLoad({ state: "error", message: errInfo(e).message });
        });
    },
    [setUnread],
  );

  useEffect(() => setFilter("all"), [orgId]);
  useEffect(() => read(filter), [read, filter, orgId]);

  const loadMore = useCallback(() => {
    if (load.state !== "ready" || !load.cursor || more === "loading") return;
    const mine = seq.current;
    setMore("loading");
    inbox
      .page(filter, load.cursor)
      .then((page) => {
        if (mine !== seq.current) return;
        setLoad((current) =>
          current.state === "ready"
            ? {
                state: "ready",
                entries: [...current.entries, ...page.entries],
                cursor: page.nextCursor,
              }
            : current,
        );
        setMore("idle");
      })
      .catch(() => mine === seq.current && setMore("failed"));
  }, [load, filter, more]);

  const markRead = useCallback(
    (entry: InboxEntry) => {
      if (entry.readAt) return;
      const now = new Date().toISOString();
      // Optimistic: the row and the dot settle now; a failure puts them back.
      setLoad((current) =>
        current.state === "ready"
          ? {
              ...current,
              entries: current.entries.map((e) => (e.id === entry.id ? { ...e, readAt: now } : e)),
            }
          : current,
      );
      decrement();
      inbox.markRead([entry.id]).catch(() => {
        setLoad((current) =>
          current.state === "ready"
            ? {
                ...current,
                entries: current.entries.map((e) =>
                  e.id === entry.id ? { ...e, readAt: null } : e,
                ),
              }
            : current,
        );
        void useInboxStore.getState().actions.refresh();
      });
    },
    [decrement],
  );

  const markAllRead = useCallback(() => {
    if (marking) return;
    setMarking(true);
    const now = new Date().toISOString();
    inbox
      .markAllRead()
      .then(() => {
        setUnread(0);
        setLoad((current) =>
          current.state === "ready"
            ? {
                ...current,
                entries: current.entries.map((e) => (e.readAt ? e : { ...e, readAt: now })),
              }
            : current,
        );
      })
      .catch(() => void useInboxStore.getState().actions.refresh())
      .finally(() => setMarking(false));
  }, [marking, setUnread]);

  const open = useCallback(
    (entry: InboxEntry) => {
      markRead(entry);
      // The Session from the server (no local path is known from the inbox;
      // the reader falls back to the server for anything not on this disk),
      // landed on the comment's thread.
      useArtifactsStore.getState().actions.openSession({
        sessionId: entry.sessionId,
        projectPath: "",
        remoteProjectId: entry.workspaceId,
        anchor: {
          kind: entry.anchorKind,
          id: entry.anchorKind === "session" ? entry.sessionId : entry.anchorId,
        },
      });
      useLayoutStore.getState().actions.addTab({
        id: "artifacts",
        type: "artifacts",
        title: "Timeline",
        closable: true,
        dirty: false,
        data: {},
      });
    },
    [markRead],
  );

  const scroller = useRef<HTMLDivElement>(null);
  const entries = load.state === "ready" ? load.entries : null;

  /** The flat list the calendar virtualizes — a day's header, then its rows —
   *  exactly as the Timeline board builds its own (`timeline-board.tsx`). */
  const items = useMemo<CalendarItem<InboxEntry>[]>(() => {
    if (!entries) return [];
    const byDay = new Map<number, InboxEntry[]>();
    for (const entry of entries) {
      const key = startOfDay(new Date(entry.createdAt));
      const bucket = byDay.get(key);
      if (bucket) bucket.push(entry);
      else byDay.set(key, [entry]);
    }
    const out: CalendarItem<InboxEntry>[] = [];
    for (const [key, list] of byDay) {
      const id = String(key);
      out.push({
        kind: "day",
        key: `day:${id}`,
        id,
        ...dayHeading(new Date(key)),
        meta: <DayMeta entries={list} directory={directory} />,
      });
      for (const entry of list) out.push({ kind: "row", key: entry.id, dayId: id, data: entry });
    }
    return out;
  }, [entries, directory]);

  // Stable, so the virtualizer's rows do not all re-render on unrelated state.
  const renderRow = useCallback(
    (entry: InboxEntry) => <InboxRow entry={entry} directory={directory} onOpen={open} />,
    [directory, open],
  );

  return (
    // A rule along the top, under the window's bar, as the Timeline has.
    <div className="flex h-full min-h-0 flex-col border-t border-border">
      <DestinationActions>
        <HintGroup side="bottom">
          <Segmented
            value={filter}
            onValueChange={setFilter}
            options={FILTERS.map((f) =>
              f.value === "unread" && unread ? { ...f, label: `Unread ${unread}` } : f,
            )}
            size="sm"
            aria-label="Show"
          />
        </HintGroup>
        <GlassIconButton
          icon={CheckCheck}
          label="Mark all as read"
          disabled={!unread || marking}
          onClick={markAllRead}
          className="size-control-md"
        />
      </DestinationActions>

      {/* The Timeline board's column (`timeline-board.tsx`): the same scroller,
          gutters and measure, so the two destinations read as one family. */}
      <div ref={scroller} className="@container hide-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col px-2 @5xl:px-10">
          <div className="relative mx-auto flex w-full max-w-232 flex-1 flex-col gap-6 px-5 pt-6 pb-32">
            {!orgId ? (
              <Empty
                title="Your inbox lives in a synced organisation"
                body="Switch to an organisation synced to Atlas Cloud to see who mentioned you, replied to you, or commented on your sessions."
              />
            ) : load.state === "loading" ? (
              <Skeleton />
            ) : load.state === "error" ? (
              <Empty title="Could not load your inbox" body={load.message}>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => read(filter)}>
                  Try again
                </Button>
              </Empty>
            ) : items.length === 0 ? (
              <Empty
                title={filter === "all" ? "Nothing here yet" : "You are caught up"}
                body="When somebody mentions you, replies to you, or comments on a session you recorded, it will appear here."
              />
            ) : (
              <>
                <TimelineCalendar
                  items={items}
                  renderRow={renderRow}
                  root={scroller as RefObject<HTMLElement | null>}
                  // Measured, as on the board: the column's own `pb-32` and
                  // the load-more sentinel follow the list, so the end space
                  // leaves room only for what they don't already give.
                  endSpace="measure"
                />
                {load.cursor && <MoreSentinel state={more} onReach={loadMore} />}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Days ────────────────────────────────────────────────────────────────────

/** A day's summary, right of its date — the board's `DayMeta`: how many
 *  updates, a hairline, and the faces of whoever acted (up to four). */
function DayMeta({ entries, directory }: { entries: InboxEntry[]; directory: OrgDirectory }) {
  const people: InboxEntry[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.actorId)) continue;
    seen.add(entry.actorId);
    people.push(entry);
    if (people.length === 4) break;
  }
  const n = entries.length;
  return (
    <span className="flex shrink-0 items-center gap-2.5 pb-0.5">
      <span className="font-mono text-2xs text-muted-foreground">
        {n} {n === 1 ? "update" : "updates"}
      </span>
      <span aria-hidden className="h-3 w-px bg-border" />
      <span className="flex items-center -space-x-1.5">
        {people.map((entry) => (
          <span key={entry.actorId} className="rounded-full ring-2 ring-background">
            <CommenterAvatar commenter={commenterOf(entry)} directory={directory} size={16} />
          </span>
        ))}
      </span>
    </span>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** Who acted, as the comment wire describes them: a guest names themself on
 *  the row and gets the generated art the web draws (`CommenterAvatar`). */
function commenterOf(entry: InboxEntry): Commenter {
  return { authorId: entry.actorId, guestName: entry.actorName };
}

/** A member no longer in the directory is a former member, as on the web. */
function actorLabel(entry: InboxEntry, directory: OrgDirectory): string {
  if (entry.actorName) return entry.actorName;
  const member = directory.byId.get(entry.actorId);
  return member ? member.name || member.email : "Former member";
}

/** One entry, at the board row's size (`session-row.tsx`): a mark column,
 *  then three lines — who did what to which Session, the comment, the
 *  Project and when. Memoized: the calendar re-renders its rows on every
 *  scroll frame, and an unchanged entry need not redraw its faces, hint and
 *  icons each time. */
const InboxRow = memo(function InboxRow({
  entry,
  directory,
  onOpen,
}: {
  entry: InboxEntry;
  directory: OrgDirectory;
  onOpen: (entry: InboxEntry) => void;
}) {
  const unread = !entry.readAt;
  const Glyph = KIND_ICON[entry.kind] ?? MessageSquare;
  const name = actorLabel(entry, directory);

  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className={cn(
        "group/row flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-left",
        "transition-colors duration-fast ease-out-strong hover:bg-element-hover",
      )}
    >
      <span className="relative flex h-5.5 w-5 shrink-0 items-center justify-center text-muted-foreground">
        <Glyph size={13} />
        {unread && (
          <span
            aria-label="Unread"
            className="absolute top-0 -right-0.5 size-1.5 rounded-full bg-primary"
          />
        )}
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-1.5 text-sm">
          <CommenterAvatar commenter={commenterOf(entry)} directory={directory} size={16} />
          <span
            className={cn(
              "shrink-0 font-medium",
              unread ? "text-foreground" : "text-secondary-foreground",
            )}
          >
            {name}
          </span>
          {entry.actorName && (
            <span className="shrink-0 rounded-full border border-border px-1.5 text-3xs font-medium tracking-[0.08em] text-muted-foreground uppercase">
              Guest
            </span>
          )}
          <span className="shrink-0 text-muted-foreground">{KIND_VERB[entry.kind]}</span>
          <span
            className={cn(
              "min-w-0 truncate",
              unread ? "text-foreground" : "text-secondary-foreground",
            )}
          >
            {entry.sessionTitle?.trim() || "an untitled session"}
          </span>
        </span>
        {entry.excerpt ? (
          <span className="line-clamp-2 text-sm text-secondary-foreground">{entry.excerpt}</span>
        ) : (
          <span className="text-sm text-muted-foreground italic">Comment deleted</span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {entry.workspaceSlug && <ProjectMark name={entry.workspaceSlug} />}
          <span aria-hidden>·</span>
          <HintGroup side="top">
            <HintItem label={formatFullTimestamp(entry.createdAt)}>
              <span>{timeAgo(entry.createdAt, { suffix: true })}</span>
            </HintItem>
          </HintGroup>
        </span>
      </span>
      <ChevronRight
        size={14}
        className="mt-1 shrink-0 text-muted-foreground transition-transform duration-fast group-hover/row:translate-x-0.5 group-hover/row:text-foreground"
      />
    </button>
  );
});

// ── States ──────────────────────────────────────────────────────────────────

function Empty({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-24 text-center">
      <span className="flex size-10 items-center justify-center rounded-full border border-border text-muted-foreground">
        <InboxIcon size={16} />
      </span>
      <p className="mt-4 text-md text-foreground">{title}</p>
      <p className="mt-1 max-w-[420px] text-sm text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}

function Skeleton() {
  return (
    <div aria-busy className="flex flex-col gap-6">
      <span className="h-7 w-56 rounded-md bg-element-hover" />
      {[0, 1, 2].map((i) => (
        <span key={i} className="flex gap-3">
          <span className="size-7 shrink-0 rounded-full bg-element-hover" />
          <span className="flex flex-1 flex-col gap-2">
            <span className="h-4 w-2/3 rounded bg-element-hover" />
            <span className="h-4 w-1/2 rounded bg-element-hover" />
          </span>
        </span>
      ))}
    </div>
  );
}

/** Loads the next page as the end of the list scrolls into view. */
function MoreSentinel({
  state,
  onReach,
}: {
  state: "idle" | "loading" | "failed";
  onReach: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || state !== "idle") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onReach();
      },
      { rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [state, onReach]);
  return (
    <div ref={ref} className="py-6 text-center text-xs text-muted-foreground">
      {state === "failed" ? (
        <button type="button" className="cursor-pointer hover:text-foreground" onClick={onReach}>
          Could not load older notifications. Try again
        </button>
      ) : state === "loading" ? (
        "Loading older notifications…"
      ) : null}
    </div>
  );
}
