/**
 * Grouped icon buttons for the Timeline header.
 *
 * The shared outline *is* the grouping: it says "these belong together and are
 * about the same thing" without a label, which is the only way to say it in a
 * 32px bar. Three groups, in the order they act on: what the board shows, which
 * rows it draws from, and then the data itself.
 *
 * Its own module rather than living in the panel, because the checkpoints picker
 * needs the trigger class too — and importing it from the panel, which imports
 * the picker, is a cycle that happens to work until someone moves a top-level
 * constant.
 */

import { cn } from "@/lib/utils";

/** A run of icon buttons sharing one outline. */
export function Segment({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-6 items-center overflow-hidden rounded-md border border-[var(--border-default)]">
      {children}
    </div>
  );
}

/** The hairline between two segments. */
export function Divider() {
  return <span className="mx-0.5 h-3.5 w-px bg-[var(--border-default)]" aria-hidden />;
}

/** One button inside a {@link Segment}. */
export function SegmentButton({
  active,
  label,
  onClick,
  divided,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  /** Draw the divider to this button's left — every member but the first. */
  divided?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        SEGMENT_TRIGGER,
        divided && "border-l border-[var(--border-default)]",
        active && SEGMENT_ACTIVE,
      )}
    >
      {children}
    </button>
  );
}

/**
 * The class a *popover trigger* wears to sit inside a {@link Segment}.
 *
 * Radix owns those elements via `asChild`, so they cannot use `SegmentButton` —
 * they take the class instead, including the `data-[state=open]` styling that
 * keeps a button lit while its menu is up.
 */
export const SEGMENT_TRIGGER =
  "flex h-full w-7 cursor-pointer items-center justify-center outline-none transition-colors " +
  "text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] " +
  "data-[state=open]:bg-[var(--bg-active)] data-[state=open]:text-[var(--text-primary)]";

/** Applied on top of {@link SEGMENT_TRIGGER} when the button's mode is on. */
export const SEGMENT_ACTIVE = "bg-[var(--bg-active)] text-[var(--text-primary)]";
