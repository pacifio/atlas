/**
 * The timeline calendar: the board grouped by day under one sticky date that
 * changes as you scroll into the next day.
 *
 * **Virtualized**, because the board holds up to five hundred Sessions and a
 * row is three lines, an avatar and two marks. Rendering all of them cost 4.5
 * seconds on mount and left a 45,000px-tall layer for the compositor to
 * rasterise — which is what the blank bands during a fast scroll were. Only
 * the rows near the viewport exist at any moment.
 *
 * Days are items in the same flat list as the rows rather than sections
 * wrapping them. A virtualizer measures one sequence; nesting a list per day
 * would mean one virtualizer per day, each wanting its own scroll element.
 *
 * Over that list sits one sticky header naming the day you are reading. It is
 * pulled up over the first day's own header (`-mt-12`, the header's height)
 * so at rest there is one date on screen, not two, and the date slides in
 * when it changes — that movement is what tells you the day changed under a
 * list that is otherwise scrolling smoothly.
 */

import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { EASE_PANEL } from "@/lib/motion";

export interface CalendarDay {
  id: string;
  /** The bright part, e.g. "October 13". */
  date: string;
  /** The quiet part after the slash, e.g. "Today" or "Monday". */
  day: string;
  /** Right-aligned summary of the day — totals, a face stack. */
  meta?: ReactNode;
}

/** One line of the flattened list: a day's header, or a row under it. */
export type CalendarItem<T> =
  | ({ kind: "day"; key: string } & CalendarDay)
  | { kind: "row"; key: string; dayId: string; data: T };

/** Header height; the sticky header and each day's header share it. */
const HEADER = "h-12";

/** Starting guesses, corrected by measurement as items mount. A day header
 *  after the first also carries the gap that separates it from the day above. */
const FIRST_DAY_SIZE = 48;
const DAY_SIZE = 88;
const ROW_SIZE = 86;

export function TimelineCalendar<T>({
  items,
  root,
  renderRow,
  className,
}: {
  items: CalendarItem<T>[];
  /** The scroll container. In this shell the window never scrolls, a panel
   *  does, and a virtualizer measuring the viewport would never fire. */
  root: RefObject<HTMLElement | null>;
  renderRow: (data: T) => ReactNode;
  className?: string;
}) {
  // The scroller is a ref owned by the board, so it is null on this
  // component's first render. One flip once it exists gets the virtualizer
  // measuring instead of silently sizing against nothing.
  const [, setScrollerReady] = useState(false);
  useEffect(() => {
    if (root.current) setScrollerReady(true);
  }, [root]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => root.current,
    estimateSize: (i) =>
      items[i]?.kind === "day" ? (i === 0 ? FIRST_DAY_SIZE : DAY_SIZE) : ROW_SIZE,
    getItemKey: (i) => items[i]?.key ?? i,
    overscan: 10,
    // A viewport's worth before the scroller has been measured. Without it
    // the first paint has a measured height of zero, so the virtualizer picks
    // no rows and the board flashes empty before its own content.
    initialRect: { width: 0, height: 900 },
  });

  const virtualRows = virtualizer.getVirtualItems();

  /** Which day each item belongs to, so the topmost visible one names the
   *  header. Reading it from the list is exact, where measuring scroll
   *  position against day offsets is a second source of truth that can
   *  disagree with what is on screen. */
  const dayOfItem = useMemo(() => {
    const byKey = new Map<string, string>();
    let currentDay: string | null = null;
    for (const item of items) {
      if (item.kind === "day") currentDay = item.id;
      if (currentDay) byKey.set(item.key, currentDay);
    }
    return byKey;
  }, [items]);

  const days = useMemo(
    () =>
      new Map(
        items
          .filter((i): i is Extract<CalendarItem<T>, { kind: "day" }> => i.kind === "day")
          .map((d) => [d.id, d]),
      ),
    [items],
  );

  const firstKey = virtualRows[0]?.key as string | undefined;
  const currentId = (firstKey ? dayOfItem.get(firstKey) : undefined) ?? [...days.keys()][0];
  const current = currentId ? days.get(currentId) : undefined;

  if (items.length === 0 || !current) return null;

  return (
    <div data-slot="timeline-calendar" className={className}>
      {/* The backing bleeds past each side, so nothing scrolling under the
          date shows at its edges. */}
      <header
        className={cn(
          HEADER,
          "sticky top-0 z-panel flex items-end border-b border-border px-2 pb-2.5",
          "before:absolute before:-inset-x-4 before:inset-y-0 before:-z-10 before:bg-background",
        )}
      >
        {/* Keyed, with no `AnimatePresence`: the key change unmounts the old
            date and mounts the new one, which plays `initial → animate`.
            Presence would keep the OUTGOING date alive for its exit, and a
            fast scroll changes the day faster than an exit completes — so
            they stacked, and "Today" sat in the header next to the day you
            had actually scrolled to and never left. */}
        <motion.div
          key={current.id}
          initial={{ x: -6, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          transition={{ duration: 0.22, ease: EASE_PANEL }}
          className="flex flex-1 items-end justify-between gap-3"
        >
          <span className="text-lg tracking-tight">
            <span className="font-medium text-foreground">{current.date}</span>
            <span className="text-muted-foreground"> / {current.day}</span>
          </span>
          {current.meta}
        </motion.div>
      </header>

      {/* `isolate`: rows raise their own hover background, and this keeps
          those layers inside the list, under the sticky date. */}
      <div className="isolate relative -mt-12" style={{ height: virtualizer.getTotalSize() }}>
        {virtualRows.map((v) => {
          const item = items[v.index];
          if (!item) return null;
          return (
            <div
              key={v.key}
              data-index={v.index}
              data-day={item.kind === "day" ? item.id : undefined}
              ref={virtualizer.measureElement}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${v.start}px)` }}
            >
              {item.kind === "day" ? (
                <DayHeader day={item} first={v.index === 0} />
              ) : (
                // `py-1`: a selected or hovered row's fill sits inside the
                // hairlines rather than touching them.
                <div className="border-b border-border-subtle py-1">{renderRow(item.data)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A day's own header, in the flow of the list. The first sits under the
 *  sticky header that is pulled over it; the rest carry the gap that
 *  separates them from the day above. */
function DayHeader({ day, first }: { day: CalendarDay; first: boolean }) {
  return (
    <div className={cn(!first && "pt-10")}>
      <h2
        // `px-2`: the date lines up with the rows' text, which sits inside
        // their fill.
        className={cn(
          HEADER,
          "flex items-end justify-between gap-3 border-b border-border px-2 pb-2.5",
        )}
      >
        <span className="text-lg tracking-tight">
          <span className="font-medium text-foreground">{day.date}</span>
          <span className="text-muted-foreground">&nbsp;/ {day.day}</span>
        </span>
        {day.meta}
      </h2>
    </div>
  );
}
