import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, Segmented } from "@tryatlas/design";
import { cn } from "@/lib/utils";
import type { DateRange, RangePreset } from "../types";
import { addDays, dayKey, fmtRange, parseDay, resolveRange } from "../lib/date-range";

const PRESETS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

/**
 * The window the whole page reads through: four presets in the package's
 * segmented track, and a custom range beside it.
 *
 * The custom picker sat inside the track as a fifth segment while the track
 * was local. The package `Segmented` has no slot for a popover trigger, so it
 * is a pill of the same height beside the track; it shows the span it picked,
 * so the control always says what the page is showing.
 *
 * The picker itself is a hand-rolled month grid rather than a date library:
 * first click sets one end, second the other, either order, with the span
 * previewing under the pointer in between.
 */
export function DateRangeControl({
  range,
  onChange,
  /** Earliest day with any data, so the grid greys out days before it. */
  earliest,
}: {
  range: DateRange;
  onChange: (r: DateRange) => void;
  earliest: string | null;
}) {
  const today = dayKey(new Date());
  const resolved = resolveRange(range, today);
  const [open, setOpen] = useState(false);
  const isCustom = range.preset === "custom";

  return (
    <div role="group" aria-label="Date range" className="flex shrink-0 items-center gap-1">
      {/* While a custom range is active no preset matches, so the track
          shows no thumb: the lit Custom button beside it says what the page
          is showing. */}
      <Segmented
        size="sm"
        aria-label="Range preset"
        value={range.preset}
        options={PRESETS}
        onValueChange={(preset) => onChange({ preset })}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <CustomRangeButton lit={isCustom} title="Custom range">
              {isCustom ? fmtRange(resolved) : "Custom"}
            </CustomRangeButton>
          }
        />
        <PopoverContent align="end" sideOffset={6} className="w-auto p-2">
          <MonthGrid
            from={isCustom ? (resolved.from ?? today) : null}
            to={isCustom ? resolved.to : null}
            today={today}
            earliest={earliest}
            onPick={(from, to) => {
              onChange({ preset: "custom", from, to });
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * The custom-range pill: the preset track's height, edge and type, lit with
 * the track's selected fill while a custom range is what the page shows.
 */
function CustomRangeButton({
  lit,
  className,
  ...props
}: React.ComponentProps<"button"> & { lit: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex h-control-md shrink-0 cursor-pointer items-center rounded-full border border-border px-2 text-2xs font-medium whitespace-nowrap tabular-nums outline-none transition-colors",
        lit ? "bg-element-selected text-foreground" : "text-muted-foreground hover:text-foreground",
        className,
      )}
    />
  );
}

const WEEKDAY = ["M", "T", "W", "T", "F", "S", "S"];

function MonthGrid({
  from,
  to,
  today,
  earliest,
  onPick,
}: {
  from: string | null;
  to: string | null;
  today: string;
  earliest: string | null;
  onPick: (from: string, to: string) => void;
}) {
  const [cursor, setCursor] = useState(() => {
    const base = parseDay(to ?? today);
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const days = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const lead = (first.getDay() + 6) % 7; // Monday-first
    const count = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const cells: Array<string | null> = Array.from({ length: lead }, () => null);
    for (let d = 1; d <= count; d++)
      cells.push(dayKey(new Date(cursor.getFullYear(), cursor.getMonth(), d)));
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [cursor]);

  // The span being shown: a committed range, or the anchor→hover preview mid-pick.
  const [selFrom, selTo] = anchor
    ? [anchor, hover ?? anchor].sort()
    : from && to
      ? [from, to]
      : [null, null];

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  const pick = (day: string) => {
    if (!anchor) {
      setAnchor(day);
      return;
    }
    const [a, b] = [anchor, day].sort();
    setAnchor(null);
    setHover(null);
    onPick(a, b);
  };

  return (
    <div className="w-[224px] select-none">
      <div className="flex items-center justify-between px-0.5 pb-1.5">
        <button
          type="button"
          aria-label="Previous month"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
        >
          <ChevronLeft size={12} />
        </button>
        <span className="text-xs font-medium text-foreground">{monthLabel}</span>
        <button
          type="button"
          aria-label="Next month"
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={dayKey(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) > today}
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
        >
          <ChevronRight size={12} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px">
        {WEEKDAY.map((w, i) => (
          <span
            key={i}
            className="flex h-5 items-center justify-center text-3xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            {w}
          </span>
        ))}
        {days.map((day, i) => {
          if (!day) return <span key={i} />;
          const future = day > today;
          const before = earliest !== null && day < earliest;
          const inSel = selFrom !== null && selTo !== null && day >= selFrom && day <= selTo;
          const edge = day === selFrom || day === selTo;
          return (
            <button
              key={day}
              type="button"
              disabled={future}
              onMouseEnter={() => anchor && setHover(day)}
              onClick={() => pick(day)}
              className={cn(
                "flex h-6 items-center justify-center text-xs tabular-nums transition-colors",
                edge
                  ? "rounded-md bg-foreground text-primary-foreground"
                  : inSel
                    ? "bg-element-active text-foreground"
                    : "rounded-md text-secondary-foreground hover:bg-element-hover hover:text-foreground",
                // Future days have not happened — hard-disabled, drawn in the
                // "unavailable" tone with no hover feedback at all. Before-data
                // days are still pickable (click handling is unchanged), just
                // unlikely to show anything, so they get the dimmer but still
                // "live" muted tone the rest of the calendar uses, and keep
                // their hover state.
                future && "cursor-default text-disabled hover:bg-transparent",
                before && !inSel && "text-muted-foreground",
                day === today &&
                  !edge &&
                  "underline decoration-muted-foreground underline-offset-2",
              )}
            >
              {Number(day.slice(-2))}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between px-0.5 text-2xs text-muted-foreground">
        <span>{anchor ? "Pick the end day" : "Pick two days"}</span>
        <button
          type="button"
          className="hover:text-foreground"
          onClick={() => onPick(addDays(today, -6), today)}
        >
          This week
        </button>
      </div>
    </div>
  );
}
