import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DateRange, RangePreset } from "../types";
import { addDays, dayKey, fmtRange, parseDay, resolveRange } from "../lib/date-range";
import { SEGMENT_ACTIVE, SEGMENT_IDLE, SEGMENT_TRIGGER, Segmented } from "./segmented";

const PRESETS: ReadonlyArray<{ value: Exclude<RangePreset, "custom">; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "all", label: "All" },
];

/**
 * The window the whole page reads through: four presets and a custom range,
 * all in ONE track.
 *
 * The custom picker used to be a second bordered button beside the presets,
 * which drew two boxes for one setting — and they are one setting, since
 * picking a range unsets the preset. It is a segment now, and it shows the
 * span it picked so the track always says what the page is showing.
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
    <Segmented
      label="Date range"
      value={isCustom ? null : range.preset}
      options={PRESETS}
      onChange={(preset) => onChange({ preset })}
    >
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={
            <button
              type="button"
              title="Custom range"
              className={cn(SEGMENT_TRIGGER, isCustom ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
            >
              <span className="tabular-nums">{isCustom ? fmtRange(resolved) : "Custom"}</span>
            </button>
          }
        />
        <Popover.Portal>
          {/* z-index belongs to the Positioner: the Popup is statically
              positioned inside it, so `z-popover` on the Popup would do
              nothing at all. `--transform-origin` is Base UI's spelling of
              Radix's `--radix-popover-content-transform-origin`. */}
          <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
            <Popover.Popup className="origin-[var(--transform-origin)] rounded-lg border border-[var(--border)] bg-[var(--card)]/90 p-2 shadow-md outline-none backdrop-blur-2xl data-closed:animate-scale-out data-open:animate-scale-in">
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
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </Segmented>
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
          className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]"
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
        >
          <ChevronLeft size={12} />
        </button>
        <span className="text-xs font-medium text-[var(--foreground)]">{monthLabel}</span>
        <button
          type="button"
          aria-label="Next month"
          className="flex size-5 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-element-hover hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-50"
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
            className="flex h-5 items-center justify-center text-3xs font-medium uppercase tracking-wider text-[var(--muted-foreground)]"
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
                  ? "rounded-md bg-[var(--foreground)] text-[var(--primary-foreground)]"
                  : inSel
                    ? "bg-element-active text-[var(--foreground)]"
                    : "rounded-md text-[var(--secondary-foreground)] hover:bg-element-hover hover:text-[var(--foreground)]",
                // Future days have not happened — hard-disabled, drawn in the
                // "unavailable" tone with no hover feedback at all. Before-data
                // days are still pickable (click handling is unchanged), just
                // unlikely to show anything, so they get the dimmer but still
                // "live" muted tone the rest of the calendar uses, and keep
                // their hover state.
                future && "cursor-default text-disabled hover:bg-transparent",
                before && !inSel && "text-[var(--muted-foreground)]",
                day === today &&
                  !edge &&
                  "underline decoration-[var(--muted-foreground)] underline-offset-2",
              )}
            >
              {Number(day.slice(-2))}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-between px-0.5 text-2xs text-[var(--muted-foreground)]">
        <span>{anchor ? "Pick the end day" : "Pick two days"}</span>
        <button
          type="button"
          className="hover:text-[var(--foreground)]"
          onClick={() => onPick(addDays(today, -6), today)}
        >
          This week
        </button>
      </div>
    </div>
  );
}
