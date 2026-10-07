/**
 * The Timeline's left nav — the session list drawn as a commit graph.
 *
 * This is deliberately the *same* renderer idea as the Git commit graph
 * (`features/git/components/commit-node.tsx`), down to the path maths: lanes at
 * fixed x, one `<svg>` per row, every segment terminating at `y = 0`,
 * a row's dot or its full height so adjacent rows butt together seamlessly, and a lane
 * change drawn as a cubic whose two control points sit on the segment's
 * vertical midpoint. Three hand-rolled curve attempts went by before this;
 * the graph had already solved it, and a sidebar that draws its thread exactly
 * like the commit graph is one idiom in the app instead of two.
 *
 * Lanes here are hierarchy rather than branches:
 *
 * * **0** — a day.
 * * **1** — a session (or a folded cluster) inside that day.
 * * **2** — the sessions inside an expanded cluster.
 *
 * Rows are a flat array so the list can be virtualized, which is the other half
 * of what the graph panel does: fixed row heights, `overscan`, a stable
 * `getItemKey`, memoized rows, absolute `translateY` positioning. A board can
 * hold 500 sessions and the nav stays a few dozen mounted rows.
 */

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowUp, Check, ChevronDown, ChevronRight, Laptop } from "lucide-react";

import { cn } from "@/lib/utils";

import { AccountAvatar } from "@/features/auth/components/account-avatar";
import { useOrgDirectory } from "@/features/organisations/lib/use-org-directory";

import { authorOf, type AuthorDirectory } from "../lib/author-directory";
import { useOnlineIds } from "../lib/team-presence";
import { boardKey } from "../lib/board-key";
import { groupSessions, sessionState, sessionTitle, type GroupPeriod } from "../lib/board";
import type { BoardSession } from "../types";
import { OnlineDot } from "./online-teammates";
import { SidebarSkeleton } from "./timeline-skeleton";

interface Props {
  sessions: BoardSession[];
  /** True while the first read for this Project is in flight. */
  loading: boolean;
  /** True when a search or facet is narrowing the board — changes the empty copy. */
  filtered: boolean;
  /** The row open on the right, highlighted here — a {@link boardKey}, since
   *  one Session id can be on the board once per Project. */
  openKey: string | null;
  /** How coarsely rows are grouped — the header's Day / Week / Month. */
  period: GroupPeriod;
  /** The project is passed back because each one has its own store. */
  onOpen: (id: string, projectPath: string, remoteProjectId: string | null) => void;
}

/** Fold a run of identical imported titles at this length or above. */
const FOLD_AT = 3;

// ── Graph geometry (mirrors `lib/git-graph.ts`) ──────────────────────────────

/**
 * Row heights. Fixed per row *kind*, which is what lets the list virtualize
 * without measuring.
 *
 * Session and cluster rows carry a second line — the Project and whether it is
 * synced — so they are taller than a day header. Everything below derives from
 * whichever applies, so changing one of these moves the rail with it.
 */
export const DAY_H = 30;
export const SESSION_H = 40;
/** Where a session row's dot sits: the centre of the whole two-line row.
 *
 *  Aligning it to the title instead put every dot a third of the way down its
 *  row, so the thread joining them read as a staircase rather than a spine. */
const SESSION_DOT_Y = SESSION_H / 2;

/** Horizontal distance between two lanes. */
const LANE_W = 12;
/** Left inset of lane 0. */
const PAD = 9;
/** Lanes the gutter must cover: day, session, cluster child. */
const LANES = 3;
/** Width of the per-row SVG. Uniform, unlike the commit graph's ragged gutter:
 *  there are only three lanes and a stable left edge reads calmer. */
const RAIL_W = PAD + LANES * LANE_W;
/** Gap from a lane's centre to the label that hangs off it. */
const LABEL_GAP = 14;
/** Dot radius — the day's mark is a touch larger than a session's. */
const DAY_R = 3.5;
const SESSION_R = 3;
/**
 * How far short of a dot the thread stops.
 *
 * The commit graph runs its lanes straight through the dots, which is right for
 * a graph where a dot is a point ON a line. Here the dots are the content and
 * the thread only relates them, so it breaks around each one.
 */
function trim(r: number): number {
  return r + 2.5;
}

/**
 * Thread and neutral dots, pulled 30% toward the surface they sit on.
 *
 * At full strength the rail competed with the titles — it is structure, not
 * content. Status colours (live, attention, today) are deliberately NOT muted:
 * they are the only things on the rail that are trying to tell you something.
 */
const THREAD = "color-mix(in srgb, var(--atlas-border-strong) 70%, var(--background))";
const DOT_NEUTRAL = "color-mix(in srgb, var(--muted-foreground) 70%, var(--background))";

function laneX(lane: number): number {
  return PAD + lane * LANE_W + LANE_W / 2;
}

/**
 * One segment of thread, in the commit graph's exact terms.
 *
 * Same lane: a straight line. Changing lane: a cubic with both control points
 * at the vertical midpoint, so the line leaves and arrives tangent to the
 * vertical and does the sideways move in between. A wide jump flattens out
 * gracefully; a fixed-radius corner would not.
 */
function segmentPath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`;
  const cy = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`;
}

// ── Flat row model ───────────────────────────────────────────────────────────

type Row =
  | { kind: "day"; key: string; lane: 0; label: string; date: string; meta: string }
  | { kind: "session"; key: string; lane: 1 | 2; session: BoardSession }
  | {
      kind: "cluster";
      key: string;
      lane: 1;
      expandKey: string;
      title: string;
      sessions: BoardSession[];
    };

/** How tall a row of this kind is. The single source the virtualizer, the
 *  wrapper and the rail all read. */
function rowHeight(row: Row | undefined): number {
  return row?.kind === "day" ? DAY_H : SESSION_H;
}

/** Where a row's dot sits. A day header is one line, so its dot is centred; a
 *  session row's belongs on the first line. */
function dotY(row: Row): number {
  return row.kind === "day" ? DAY_H / 2 : SESSION_DOT_Y;
}

/** Scroll position, kept across tab switches — the panel unmounts on every one,
 *  and landing back at the top of a 500-row nav loses your place. Module-level
 *  and single-valued: there is one Timeline. */
let scrollTopCache = 0;

export function TimelineSidebar({ sessions, loading, filtered, openKey, period, onOpen }: Props) {
  // One subscription for the whole nav. Five hundred rows each resolving their
  // own author would re-render the list every time the roster revalidated.
  const directory = useOrgDirectory();
  // Same reason: one subscription, and each row is handed a boolean so a
  // teammate coming online re-renders only their own rows.
  const online = useOnlineIds();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const days = useMemo(() => groupSessions(sessions, period), [sessions, period]);
  const parentRef = useRef<HTMLDivElement | null>(null);
  /** Which edges are scrolled away from — drives the two fades. */
  const [edges, setEdges] = useState({ top: false, bottom: false });

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const day of days) {
      out.push({
        kind: "day",
        key: `day:${day.label}`,
        lane: 0,
        label: day.label,
        date: day.date,
        meta: day.meta,
      });
      for (const item of clusterRows(day.sessions)) {
        if (item.kind === "single") {
          out.push({
            kind: "session",
            key: boardKey(item.session),
            lane: 1,
            session: item.session,
          });
          continue;
        }
        const expandKey = `${day.label}:${item.title}`;
        out.push({
          kind: "cluster",
          key: `cluster:${expandKey}`,
          lane: 1,
          expandKey,
          title: item.title,
          sessions: item.sessions,
        });
        if (expanded.has(expandKey)) {
          for (const session of item.sessions) {
            out.push({ kind: "session", key: boardKey(session), lane: 2, session });
          }
        }
      }
    }
    return out;
  }, [days, expanded]);

  // Both of these are memoised on `rows`, and it is load-bearing rather than
  // habit. `getItemKey` is a dependency of the virtualizer's own
  // `getMeasurementOptions` memo, which `getMeasurements` depends on — so a
  // fresh closure per render invalidates both and recomputes all ~500 row
  // measurements. The virtualizer re-renders this component on every scroll
  // frame, which made that a per-frame cost.
  const estimateSize = useCallback((i: number) => rowHeight(rows[i]), [rows]);
  const getItemKey = useCallback((i: number) => rows[i]?.key ?? i, [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    // Exact, not an estimate: every kind has a fixed height, so the list never
    // has to measure and never reflows as rows scroll into view.
    estimateSize,
    overscan: 12,
    getItemKey,
  });

  const toggle = useCallback(
    (key: string) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  // Restore the scroll offset this nav had when the tab was last open.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (el && scrollTopCache > 0) el.scrollTop = scrollTopCache;
  }, []);

  // One passive listener does both jobs: remember the offset, and decide which
  // fades are showing. `setEdges` only fires when a boolean actually flips, so
  // a fling is not a render per frame.
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const read = () => {
      scrollTopCache = el.scrollTop;
      const top = el.scrollTop > 2;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }));
    };
    read();
    el.addEventListener("scroll", read, { passive: true });
    return () => {
      scrollTopCache = el.scrollTop;
      el.removeEventListener("scroll", read);
    };
    // Re-read when the row count changes: a filter that shortens the list can
    // remove the bottom fade without anyone scrolling.
  }, [rows.length]);

  // A Session opened from outside — the git panel's history, a checkpoint — can
  // be hundreds of rows down and, virtualized, not mounted at all. Scroll by
  // index instead of hunting for the element.
  //
  // Keyed on the open id alone, never on `rows`: the board re-reads on every
  // capture event, and re-centring the list under the pointer each time would
  // make it impossible to browse while an agent is working.
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!openKey || revealed.current === openKey) return;
    const index = rows.findIndex((r) => r.kind === "session" && r.key === openKey);
    if (index < 0) return;
    revealed.current = openKey;
    virtualizer.scrollToIndex(index, { align: "center" });
  }, [openKey, rows, virtualizer]);

  // Structure rather than a sentence: the read is usually a few milliseconds,
  // and a line of prose that appears and vanishes reads as a flash of error.
  if (loading) return <SidebarSkeleton dayHeight={DAY_H} sessionHeight={SESSION_H} />;
  if (rows.length === 0) return <Empty filtered={filtered} />;

  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative min-h-0 flex-1">
      {/* `overflow-x-hidden` is load-bearing, not tidiness. Setting only
       *  `overflow-y` leaves the other axis `visible`, which CSS then computes
       *  to `auto` — so a long title made the whole nav scroll sideways, and
       *  because the content box was wider than the pane nothing ever hit the
       *  width it was supposed to truncate at. Clamping x is what makes
       *  `truncate` on the rows mean anything. */}
      <div ref={parentRef} className="hide-scrollbar h-full overflow-y-auto overflow-x-hidden py-2">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {items.map((v) => {
            const row = rows[v.index];
            const prev = rows[v.index - 1];
            return (
              <div
                key={row.key}
                data-index={v.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: rowHeight(row),
                  transform: `translateY(${v.start}px)`,
                }}
              >
                <Rail
                  lane={row.lane}
                  prevLane={prev ? prev.lane : null}
                  hasNext={v.index < rows.length - 1}
                  r={row.kind === "day" ? DAY_R : SESSION_R}
                  h={rowHeight(row)}
                  dotY={dotY(row)}
                  prevDotY={prev ? dotY(prev) : null}
                />
                {row.kind === "day" ? (
                  <DayRow row={row} />
                ) : row.kind === "cluster" ? (
                  <ClusterRow
                    row={row}
                    expanded={expanded.has(row.expandKey)}
                    holdsOpen={!!openKey && row.sessions.some((s) => boardKey(s) === openKey)}
                    onToggle={toggle}
                  />
                ) : (
                  <SessionRow
                    session={row.session}
                    lane={row.lane}
                    selected={row.key === openKey}
                    directory={directory}
                    authorOnline={row.session.authorId !== null && online.has(row.session.authorId)}
                    onOpen={onOpen}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Fades, not borders: the list has no fixed edge to draw on — it runs
          under the header above and under the search pill below. Each one only
          appears once there is something behind it to hide. */}
      <Fade edge="top" show={edges.top} />
      <Fade edge="bottom" show={edges.bottom} />

      {/* Back to the top, floating over the bottom fade the way the Session
          detail floats its own controls. Only while there IS a top to go back
          to: on a board of 500 rows the return trip is the one navigation the
          list cannot otherwise offer, and at the top it would be a button that
          does nothing. Search moved to the pane header.

          It says "Jump to Today" rather than "Top" because the list is dated:
          the top of a Timeline is not a position, it is a day, and naming the
          day says where you will land. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center">
        <button
          type="button"
          onClick={() => virtualizer.scrollToIndex(0, { align: "start" })}
          className={cn(
            "pointer-events-auto flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--card)]/85 px-3 text-xs text-[var(--secondary-foreground)] shadow-md backdrop-blur-xl transition-opacity duration-150 hover:text-[var(--foreground)]",
            edges.top ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          tabIndex={edges.top ? undefined : -1}
          aria-hidden={!edges.top}
        >
          <ArrowUp size={12} strokeWidth={1.6} />
          Jump to Today
        </button>
      </div>
    </div>
  );
}

/** One end of the scroller, faded into the surface behind it. */
function Fade({ edge, show }: { edge: "top" | "bottom"; show: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-10 h-10 transition-opacity duration-150",
        edge === "top" ? "top-0" : "bottom-0",
        show ? "opacity-100" : "opacity-0",
      )}
      style={{
        background: `linear-gradient(to ${edge === "top" ? "bottom" : "top"}, var(--background), transparent)`,
      }}
    />
  );
}

/** The thread through one row: in from the row above, out to the row below. */
const Rail = memo(function Rail({
  lane,
  prevLane,
  hasNext,
  r,
  h,
  dotY: cy,
  prevDotY,
}: {
  lane: number;
  /** `null` on the very first row — the thread starts at its dot. */
  prevLane: number | null;
  hasNext: boolean;
  /** This row's dot radius, so the thread can stop clear of it. */
  r: number;
  /** This row's height. Passed rather than read from a constant: day rows and
   *  session rows are different heights now. */
  h: number;
  /** Where this row's dot sits vertically. */
  dotY: number;
  /** The row above's dot offset, measured up from this row's top edge — so the
   *  thread leaves the previous dot rather than the previous row's midpoint.
   *  `null` on the very first row. */
  prevDotY: number | null;
}) {
  const x = laneX(lane);
  const gap = trim(r);
  const parts: string[] = [];
  // The lane change always happens in the TOP half of the arriving row, so the
  // row above can leave straight down and every join lands on a dot. The
  // segment starts at 0 — the previous row's own rail already ran from its dot
  // down to its bottom edge, which is this row's 0.
  void prevDotY;
  if (prevLane !== null) parts.push(segmentPath(laneX(prevLane), 0, x, cy - gap));
  if (hasNext) parts.push(segmentPath(x, cy + gap, x, h));
  return (
    <svg
      aria-hidden
      width={RAIL_W}
      height={h}
      className="pointer-events-none absolute left-0 top-0"
    >
      {parts.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={THREAD}
          strokeWidth={1.5}
          shapeRendering="geometricPrecision"
        />
      ))}
    </svg>
  );
});

/** A dot on a lane. Always filled — a ring would read as a different kind of
 *  thing, and every row here is the same kind of thing. */
function Dot({
  lane,
  r,
  cy,
  className,
  style,
}: {
  lane: number;
  r: number;
  /** Distance from the row's top edge to the dot's centre. Explicit rather than
   *  `top-1/2`, because a two-line row's dot belongs on the first line, not
   *  halfway down the pair. */
  cy: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={cn("absolute z-10 rounded-full", className)}
      style={{ left: laneX(lane) - r, top: cy - r, width: r * 2, height: r * 2, ...style }}
    />
  );
}

const DayRow = memo(function DayRow({ row }: { row: Extract<Row, { kind: "day" }> }) {
  const today = row.label === "Today";
  return (
    <div
      title={`${row.date} · ${row.meta}`}
      className="relative flex h-full items-center pr-3 text-sm font-medium"
      style={{ paddingLeft: laneX(0) + LABEL_GAP }}
    >
      <Dot
        lane={0}
        r={DAY_R}
        cy={DAY_H / 2}
        className={today ? "bg-[var(--primary)]" : undefined}
        style={today ? undefined : { background: DOT_NEUTRAL }}
      />
      <span
        className={cn(
          "truncate",
          today ? "text-[var(--primary)]" : "text-[var(--secondary-foreground)]",
        )}
      >
        {row.label}
      </span>
    </div>
  );
});

/**
 * The shared row shell for anything that is not a period header.
 *
 * ## Why selection is 8% and not the 15% accent wash it was
 *
 * Hover used to sit on `--atlas-element-active` (8%), which left selection
 * nowhere to go on the token scale — so it reached past the top of it for a 15%
 * wash, brighter than `--atlas-element-emphasis`. On an AMOLED-black surface
 * that is a light grey slab, and the row's own text loses contrast against it.
 *
 * The fix is the scale, not the one value: hover drops to
 * `--atlas-element-hover` (4%) and selection takes `--atlas-element-active`
 * (8%). Two clean steps, both from the scale, and selection is still visibly
 * above hover — which is the thing the previous note was protecting and the
 * reason it could not simply use the 4%/6% pair.
 */
const ROW =
  "relative flex h-full w-full cursor-pointer items-center pr-3 text-left transition-colors hover:bg-[var(--atlas-element-hover)]";
/** The two-line variant: the title over the Project-and-author byline. */
const ROW_STACKED =
  "relative flex h-full w-full cursor-pointer flex-col justify-center gap-0.5 pr-3 text-left transition-colors hover:bg-[var(--atlas-element-hover)]";
/** Held on hover too, so pointing at the open row does not brighten it. */
const ROW_SELECTED = "bg-[var(--atlas-element-active)] hover:bg-[var(--atlas-element-active)]";

// memo: the board re-renders on every capture/git event while the tab is open;
// with the parent's same-data bailout keeping row identities stable, memo
// confines a live session's churn to its own row.
const SessionRow = memo(function SessionRow({
  session,
  lane,
  selected,
  directory,
  authorOnline,
  onOpen,
}: {
  session: BoardSession;
  /** 2 when this row is inside an expanded cluster. */
  lane: 1 | 2;
  selected: boolean;
  /** Stable across renders, so `memo` on this row still pays for itself. */
  directory: AuthorDirectory;
  /** The author is online right now. */
  authorOnline: boolean;
  onOpen: (id: string, projectPath: string, remoteProjectId: string | null) => void;
}) {
  const state = sessionState(session);
  const title = sessionTitle(session.title);
  return (
    <button
      type="button"
      data-session-id={session.id}
      data-selected={selected || undefined}
      onClick={() => onOpen(session.id, session.projectPath, session.remoteProjectId)}
      title={session.attentionReason ?? title ?? undefined}
      className={cn(ROW_STACKED, selected && ROW_SELECTED)}
      style={{ paddingLeft: laneX(lane) + LABEL_GAP }}
    >
      <Dot
        lane={lane}
        r={SESSION_R}
        cy={SESSION_DOT_Y}
        className={cn(
          state === "live" && "atlas-live-pulse bg-[var(--atlas-status-success-foreground)]",
          state === "attention" && "bg-[var(--atlas-status-warning-foreground)]",
        )}
        style={
          state === "live"
            ? {
                ["--atlas-pulse-color" as string]:
                  "color-mix(in oklab, var(--atlas-status-success-foreground) 40%, transparent)",
              }
            : state === "attention"
              ? undefined
              : { background: DOT_NEUTRAL }
        }
      />
      <FadingTitle
        className={cn(
          selected
            ? "text-[var(--foreground)]"
            : lane === 2 || state === "done"
              ? "text-[var(--secondary-foreground)]"
              : "text-[var(--foreground)]",
          !title && "text-[var(--muted-foreground)]",
        )}
      >
        {title ?? "Untitled session"}
      </FadingTitle>
      <SessionMeta session={session} directory={directory} authorOnline={authorOnline} />
    </button>
  );
});

/**
 * The second line: which Project, and whether it is on the server.
 *
 * The icon answers one question — "can a teammate see this?" — and it is a
 * property of the Project, not of how much of the Session has drained. A tick
 * that flickered with the outbox queue would read as a fault every time capture
 * ran ahead of the network, which is always.
 */
const SessionMeta = memo(function SessionMeta({
  session,
  directory,
  authorOnline,
}: {
  session: BoardSession;
  directory: AuthorDirectory;
  authorOnline: boolean;
}) {
  const Icon = session.synced ? Check : Laptop;
  const author = authorOf(session.authorId, directory);
  return (
    <span className="flex w-full min-w-0 items-center gap-1.5 text-2xs leading-tight text-[var(--muted-foreground)]">
      <Icon
        size={9}
        className={cn(
          "shrink-0",
          session.synced
            ? "text-[var(--atlas-status-success-foreground)]"
            : "text-[var(--atlas-text-disabled)]",
        )}
        aria-label={session.synced ? "Shared with your Organization" : "This machine only"}
      />
      {/* The Project first, because it is what a reader scanning the day is
       *  grouping by. It is the part that gives way when the pane is narrow. */}
      <span className="min-w-0 truncate">{session.projectName}</span>
      {/* Whose work it is, pinned right by `ml-auto` rather than by letting the
       *  Project grow into the gap: a Project name short enough not to truncate
       *  would otherwise drag the byline left and leave the column ragged all
       *  the way down the list. Never truncated and never dropped — a half-name
       *  reads as the wrong person, which is worse than no byline at all. */}
      <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
        {author.avatar && (
          // The dot only for a teammate: your own face is always "here", and
          // a green dot on every one of your own rows would be noise.
          <span className="relative inline-flex shrink-0">
            <AccountAvatar user={author.avatar} size={10} />
            {authorOnline && !author.isSelf && <OnlineDot px={4} />}
          </span>
        )}
        <span className={cn(author.isSelf && "text-[var(--atlas-text-disabled)]")}>
          {author.label}
        </span>
      </span>
    </span>
  );
});

/** How much of the title's right edge is given over to the fade. */
const TITLE_FADE_PX = 32;

/**
 * `currentColor` rather than a literal: a mask reads only the alpha channel, so
 * the hue is irrelevant and naming one would be a colour that means nothing.
 *
 * Hoisted out of the component so the two style values are one constant object
 * rather than a fresh pair of strings per row per render.
 */
const TITLE_MASK = `linear-gradient(to right, currentColor calc(100% - ${TITLE_FADE_PX}px), transparent)`;
const TITLE_FADE_STYLE = { maskImage: TITLE_MASK, WebkitMaskImage: TITLE_MASK } as const;

/**
 * A title that dissolves at its right edge instead of ending in an ellipsis.
 *
 * The fade is on the **text**, not on the row. An overlay across the whole row
 * — which is what this replaced — washes out whatever else shares the line, and
 * the byline sitting at that edge came out grey on every row.
 *
 * ## Why this needs no measurement, despite appearances
 *
 * The obvious objection is that an unconditional mask would fade the last 32px
 * of *every* title, including short ones that fit — and this component did
 * measure, for exactly that reason. The reasoning was wrong.
 *
 * The span is `w-full`, so the mask is laid over a **full-width box**, and its
 * fade region sits at the right edge of that box rather than at the end of the
 * text. A short title stops well before it and is never touched. Only text that
 * actually reaches the last 32px is faded — which is the behaviour the
 * measurement was trying to buy.
 *
 * ## Why measuring was not merely redundant but harmful
 *
 * It read `scrollWidth` from a `useLayoutEffect`, so every row scrolling into
 * view forced a synchronous reflow and then a `setState` *before paint*,
 * costing a second render and a second layout — per row, several rows per
 * frame. That is what took the nav off 60fps. `Clamp` in `session-detail.tsx`
 * is the pattern to follow if a measurement is ever genuinely needed here:
 * plain `useEffect`, read inside the observer callback, never on the mount path.
 *
 * ## The one case given up
 *
 * A title that *ends* within the last 32px fades its final characters even
 * though it fits. It reads as a word running to the edge, and it is rare — most
 * titles are either clearly short or clearly long. Narrow `TITLE_FADE_PX` if it
 * ever grates; do not bring back the measurement.
 */
const FadingTitle = memo(function FadingTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "w-full min-w-0 overflow-hidden whitespace-nowrap text-sm leading-tight tracking-[-0.01em]",
        className,
      )}
      style={TITLE_FADE_STYLE}
    >
      {children}
    </span>
  );
});

const ClusterRow = memo(function ClusterRow({
  row,
  expanded,
  holdsOpen,
  onToggle,
}: {
  row: Extract<Row, { kind: "cluster" }>;
  expanded: boolean;
  /** Folded, but the Session open on the right is one of its children. */
  holdsOpen: boolean;
  onToggle: (key: string) => void;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      onClick={() => onToggle(row.expandKey)}
      aria-expanded={expanded}
      title={row.title}
      className={cn(ROW, holdsOpen && !expanded && ROW_SELECTED)}
      style={{ paddingLeft: laneX(1) + LABEL_GAP }}
    >
      <Dot lane={1} r={SESSION_R} cy={SESSION_DOT_Y} style={{ background: DOT_NEUTRAL }} />
      <span
        className={cn(
          "min-w-0 truncate text-base leading-tight tracking-[-0.01em]",
          holdsOpen ? "text-[var(--foreground)]" : "text-[var(--secondary-foreground)]",
        )}
      >
        {row.title}
      </span>
      <span className="ml-1.5 shrink-0 font-mono text-2xs text-[var(--muted-foreground)]">
        ×{row.sessions.length}
      </span>
      <Chevron
        size={11}
        strokeWidth={1.5}
        className="ml-auto shrink-0 text-[var(--muted-foreground)]"
      />
    </button>
  );
});

// ── Clustering ──────────────────────────────────────────────────────────────

type ListItem =
  | { kind: "single"; session: BoardSession }
  | { kind: "cluster"; title: string; sessions: BoardSession[] };

/**
 * Fold imported sessions that share an identical title into one row.
 *
 * Three is the threshold: two identical titles is coincidence, a run of them is
 * a machine. Only imported sessions fold — live captures are something the
 * developer did here, however repetitive.
 */
export function clusterRows(rows: BoardSession[]): ListItem[] {
  const byTitle = new Map<string, number>();
  for (const session of rows) {
    if (session.source === "external_jsonl" && session.title) {
      byTitle.set(session.title, (byTitle.get(session.title) ?? 0) + 1);
    }
  }

  const items: ListItem[] = [];
  const folded = new Map<string, BoardSession[]>();
  for (const session of rows) {
    const foldable =
      session.source === "external_jsonl" &&
      session.title !== null &&
      (byTitle.get(session.title) ?? 0) >= FOLD_AT;
    if (!foldable) {
      items.push({ kind: "single", session });
      continue;
    }
    const bucket = folded.get(session.title!);
    if (bucket) {
      bucket.push(session);
    } else {
      const sessions: BoardSession[] = [session];
      folded.set(session.title!, sessions);
      // Placed where its first member sat, so folding never reorders the day.
      items.push({ kind: "cluster", title: session.title!, sessions });
    }
  }
  return items;
}

function Empty({ filtered }: { filtered: boolean }) {
  return (
    <div className="px-4 py-12 text-center">
      <p className="text-sm text-[var(--secondary-foreground)]">
        {filtered ? "No sessions match this filter." : "No sessions captured yet."}
      </p>
      {!filtered && (
        <p className="mt-1 text-xs text-[var(--muted-foreground)]">
          Send a prompt to an agent in this Project and it will appear here.
        </p>
      )}
    </div>
  );
}
