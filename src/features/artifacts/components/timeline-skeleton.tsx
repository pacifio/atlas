/**
 * What the Timeline looks like before it has anything to show.
 *
 * Purpose-built rather than `@/components/panel-skeleton`, which draws a column
 * of uniform bars. These mirror the real geometry — the rail and its dots, a
 * title over a byline, a masthead over a metric strip — so the switch to real
 * content is a fill rather than a re-layout. A skeleton whose shape does not
 * match what replaces it is just a differently-shaped spinner.
 *
 * **Static, no shimmer**, following `PanelSkeleton`'s convention. The nav is
 * read at speed and an animated placeholder pulls the eye to the thing that is
 * least worth looking at.
 */

import { cn } from "@/lib/utils";

/** The bars. Faint enough to read as absence rather than as content. */
const BAR = "rounded bg-element-selected";

/**
 * Deterministic, not random, widths.
 *
 * A skeleton that reshuffles on every render flickers while a slow read
 * settles; the point is to look like a list at rest.
 */
const TITLE_WIDTHS = [86, 62, 94, 71, 55, 88, 66, 79, 48, 91, 73, 58];

/** How many rows sit under each day header, cycling down the list. */
const PER_DAY = [3, 5, 2, 4];

/**
 * The board before its Sessions arrive.
 *
 * Mirrors the real geometry — a day header, then three-line rows carrying a
 * status glyph, a title, a meta line and a byline — so the switch to real
 * content is a fill rather than a re-layout. A skeleton whose shape does not
 * match what replaces it is just a differently-shaped spinner.
 */
export function BoardSkeleton({ rows = 12 }: { rows?: number }) {
  // Lay the rows out the way the real board does: a day header, then its
  // sessions, then the next day.
  const shape: Array<"day" | "session"> = [];
  let day = 0;
  while (shape.length < rows) {
    shape.push("day");
    for (let i = 0; i < PER_DAY[day % PER_DAY.length]! && shape.length < rows; i++) {
      shape.push("session");
    }
    day++;
  }

  return (
    <div aria-hidden>
      {shape.map((kind, i) =>
        kind === "day" ? (
          <div
            key={i}
            className={cn(
              "flex h-12 items-end justify-between border-b border-border pb-2.5",
              i > 0 && "mt-10",
            )}
          >
            <span className={cn(BAR, "h-4 w-40")} />
            <span className={cn(BAR, "h-2.5 w-24")} />
          </div>
        ) : (
          <div key={i} className="flex items-start gap-2.5 border-b border-border-subtle py-2.5">
            <span className={cn(BAR, "mt-1 size-3.5 shrink-0 rounded-full")} />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="flex items-center gap-3">
                <span
                  className={cn(BAR, "h-3.5")}
                  style={{ width: `${TITLE_WIDTHS[i % TITLE_WIDTHS.length]}%` }}
                />
                <span className={cn(BAR, "ml-auto h-5 w-28 rounded-full")} />
              </span>
              <span className="flex items-center gap-2">
                <span className={cn(BAR, "h-2.5 w-14")} />
                <span className={cn(BAR, "h-2.5 w-20")} />
                <span className={cn(BAR, "h-2.5 w-16")} />
              </span>
              <span className="flex items-center gap-2">
                <span className={cn(BAR, "size-4 shrink-0 rounded-full")} />
                <span className={cn(BAR, "h-2.5 w-24")} />
                <span className={cn(BAR, "ml-auto h-2.5 w-28")} />
              </span>
            </span>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * The detail pane before its Session arrives.
 *
 * Matches `SessionDetail`'s masthead — title, chip row, the four-cell metric
 * strip — then a few entry rows on their own rail.
 */
export function DetailSkeleton() {
  return (
    <div aria-hidden className="h-full overflow-hidden px-14 pt-14">
      <span className={cn(BAR, "block h-6 w-[58%]")} />

      <div className="mt-[22px] flex items-center gap-2">
        <span className={cn(BAR, "h-[22px] w-24 rounded-full")} />
        <span className={cn(BAR, "h-[22px] w-20 rounded-full")} />
        <span className={cn(BAR, "h-3 w-28")} />
      </div>

      {/* The metric strip: four cells, each a label over a figure. */}
      <div className="mt-8 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-element-selected">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2.5 p-3.5">
            <span className={cn(BAR, "h-2 w-16")} />
            <span className={cn(BAR, "h-4 w-20")} />
            <span className={cn(BAR, "h-2 w-24")} />
          </div>
        ))}
      </div>

      {/* Entries, on the rail the real ones hang off. */}
      <div className="mt-14 space-y-6">
        {[92, 70, 84].map((width, i) => (
          <div key={i} className="grid grid-cols-[32px_minmax(0,1fr)] gap-3.5">
            <span className="flex justify-center">
              <span className={cn(BAR, "size-5 rounded-full")} />
            </span>
            <span className="flex min-w-0 flex-col gap-2">
              <span className={cn(BAR, "h-3 w-28")} />
              <span className={cn(BAR, "h-3")} style={{ width: `${width}%` }} />
              <span className={cn(BAR, "h-3")} style={{ width: `${width - 22}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
