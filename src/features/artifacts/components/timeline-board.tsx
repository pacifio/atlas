/**
 * The Timeline board: every captured Session, by day, on the whole tab.
 *
 * This replaced a 280px nav whose rows could say a title and a time and
 * nothing else — which model ran, whose work it was, what it changed and how
 * much it cost all meant opening the Session to find out. Those are the facts
 * you choose a Session *by*, so the board is now the page and a row carries
 * them ({@link SessionRow}).
 *
 * The frame is a centred column: a reading measure, not a stretched table.
 * One sticky date names the day you are in and changes as you scroll
 * ({@link TimelineCalendar}); the filters sit in the destination bar beside the
 * page title (ADR-0024), so the page draws no heading of its own; the search
 * bar floats at the foot over a fade, where your hands are.
 */

import { useCallback, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { DestinationActions } from "@/features/layout/components/destination-actions";
import type { BoardSession } from "../types";
import { boardKey } from "../lib/board-key";
import { dayHeading, startOfDay } from "../lib/board";
import type { AuthorDirectory } from "../lib/author-directory";
import { DayMeta, SessionRow } from "./session-row";
import { BoardSkeleton } from "./timeline-skeleton";
import { TimelineCalendar, type CalendarItem } from "./timeline-calendar";

export function TimelineBoard({
  sessions,
  directory,
  openKey,
  loading,
  narrowed,
  query,
  onQuery,
  onOpen,
  filters,
  note,
}: {
  /** Already scoped by the filters and the search — the board only groups. */
  sessions: BoardSession[];
  directory: AuthorDirectory;
  /** The row to mark as open, as a {@link boardKey} key. */
  openKey: string | null;
  loading: boolean;
  /** A filter or a query is on, so "nothing here" means "nothing matched". */
  narrowed: boolean;
  query: string;
  onQuery: (next: string) => void;
  onOpen: (session: BoardSession) => void;
  /** The filter pills, in the header beside the title. */
  filters?: ReactNode;
  /** A standing note under the list — what the board is NOT showing. */
  note?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  /** The flat list the calendar virtualizes: a day's header, then its rows. */
  const items = useMemo<CalendarItem<BoardSession>[]>(() => {
    // Insertion order is the store's order — newest first — so grouping needs
    // no second sort.
    const byDay = new Map<number, BoardSession[]>();
    for (const s of sessions) {
      const key = startOfDay(new Date(s.lastActivityAt));
      const bucket = byDay.get(key);
      if (bucket) bucket.push(s);
      else byDay.set(key, [s]);
    }
    const out: CalendarItem<BoardSession>[] = [];
    for (const [key, list] of byDay) {
      const id = String(key);
      out.push({
        kind: "day",
        key: `day:${id}`,
        id,
        ...dayHeading(new Date(key)),
        meta: <DayMeta sessions={list} directory={directory} />,
      });
      for (const s of list) out.push({ kind: "row", key: boardKey(s), dayId: id, data: s });
    }
    return out;
  }, [sessions, directory]);

  // Stable across renders so the virtualizer's rows do not all re-render when
  // an unrelated piece of board state changes.
  const renderRow = useCallback(
    (s: BoardSession) => (
      <SessionRow
        session={s}
        directory={directory}
        selected={boardKey(s) === openKey}
        onOpen={() => onOpen(s)}
      />
    ),
    [directory, openKey, onOpen],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="@container hide-scrollbar min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col px-2 @5xl:px-10">
          <div className="relative mx-auto flex w-full max-w-232 flex-1 flex-col gap-6 px-5 pt-6 pb-32">
            {filters && (
              <DestinationActions>
                <div className="flex shrink-0 items-center gap-2">{filters}</div>
              </DestinationActions>
            )}

            {items.length > 0 ? (
              <TimelineCalendar
                items={items}
                renderRow={renderRow}
                root={scroller as RefObject<HTMLElement | null>}
              />
            ) : loading ? (
              // Geometry-matched rows rather than a spinner: the shape of what
              // is coming is itself information, and a list that fades in at
              // the size it will be does not shift the page when it lands.
              <BoardSkeleton />
            ) : (
              <p className="py-20 text-center text-xs text-muted-foreground">
                {narrowed ? "No sessions match." : "No sessions captured yet."}
              </p>
            )}

            {note}
          </div>
        </div>
      </div>

      {/* The search, at the foot of the list: a fade so rows sink under it,
          then the bar. At the foot because it is a thing you reach for while
          reading, not a filter you set before you start. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-linear-to-b from-transparent to-[var(--card)]"
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-4 pb-3.5">
        <label
          className={cn(
            "pointer-events-auto flex h-10 w-full max-w-155 items-center gap-2.5",
            "rounded-full border border-border bg-[var(--card)]/80 px-4 shadow-md backdrop-blur-xl",
          )}
        >
          <Search size={14} className="shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                onQuery("");
              }
            }}
            placeholder="Search sessions…"
            aria-label="Search sessions"
            spellCheck={false}
            maxLength={256}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-[var(--atlas-text-disabled)]"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                onQuery("");
                searchRef.current?.focus();
              }}
              className="grid size-control-xs shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors duration-fast hover:bg-element-hover hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </label>
      </div>
    </div>
  );
}
