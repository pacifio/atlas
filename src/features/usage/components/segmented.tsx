import { cn } from "@/lib/utils";

/**
 * A one-of-N control: a round-ended track with the active option a filled pill
 * inside it.
 *
 * The same shape the Timeline's grain control uses (`artifacts-panel.tsx`'s
 * `PeriodPill`), and for the same reason: these are STATES, exactly one of
 * which is true, and the filled pill says which at a glance. The bordered
 * rectangles this replaced drew a box per control, so a header carrying three
 * of them read as three separate widgets rather than three settings.
 *
 * `h-control-sm`, one step under the facet pills beside it (`h-control-md`):
 * the track is deliberately the quieter of the two, since a facet pill opens a
 * menu and a segment only flips a switch.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  children,
}: {
  /** `null` = nothing active, for a track whose state lives elsewhere. */
  value: T | null;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  /** Accessible name for the group — these tracks carry no visible label. */
  label: string;
  className?: string;
  /** Extra segments sharing the track, e.g. a popover trigger. */
  children?: React.ReactNode;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      title={label}
      className={cn(
        "flex h-control-sm shrink-0 items-center rounded-full border border-[var(--border)] p-0.5",
        className,
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(SEGMENT_TRIGGER, o.value === value ? SEGMENT_ACTIVE : SEGMENT_IDLE)}
        >
          {o.label}
        </button>
      ))}
      {children}
    </div>
  );
}

/** A non-radio segment sharing a `Segmented` track — the custom-range trigger. */
export const SEGMENT_TRIGGER =
  "flex h-full cursor-pointer items-center gap-1 rounded-full px-2 text-xs leading-none outline-none transition-colors";
export const SEGMENT_ACTIVE = "bg-element-active font-medium text-[var(--foreground)]";
export const SEGMENT_IDLE =
  "text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]";
