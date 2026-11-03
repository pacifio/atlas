// The Memory surface's shared chrome, props-only: the toolbar strip, the
// round-ended track its one-of-N switches sit in, the search field, the
// centred notice every gate and empty state uses, and the table header.
//
// Drawn in the Usage and Timeline grammar: achromatic surfaces, hairline
// borders, no fills behind a track, a selected segment as the element ramp's
// selected step. Each piece used to be restated per view, in four slightly
// different heights and radii.

import type { ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** A view's toolbar: one hairline-ruled strip above its body. */
export function Toolbar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("flex h-10 shrink-0 items-center gap-2 border-b border-border px-3", className)}
    >
      {children}
    </div>
  );
}

/** A round-ended hairline track holding `TrackSegment`s. */
export function Track({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-control-sm shrink-0 items-center gap-0.5 rounded-full border border-border p-0.5",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One segment of a `Track`. A plain button: callers keep their own semantics. */
export function TrackSegment({
  active,
  onClick,
  title,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={cn(
        "flex h-full cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
        "transition-colors duration-fast ease-out-strong",
        "disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "bg-element-selected text-foreground"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** A count beside a label: the element ramp's pill, as the Usage tabs draw it. */
export function CountPill({ count, active }: { count: number; active?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-px text-3xs tabular-nums",
        active
          ? "bg-element-active text-secondary-foreground"
          : "bg-element-hover text-muted-foreground",
      )}
    >
      {count}
    </span>
  );
}

/** A search field with its glyph inside, on the `Input` primitive's tokens. */
export function SearchField({
  value,
  onChange,
  onKeyDown,
  placeholder,
  className,
  trailing,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  placeholder: string;
  className?: string;
  trailing?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex h-control-sm items-center gap-1.5 rounded border border-border bg-panel-input px-2",
        "transition-colors duration-fast ease-out-strong focus-within:border-border-strong",
        className,
      )}
    >
      <Search size={12} className="shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground"
      />
      {trailing}
    </div>
  );
}

/** A centred notice: a gate, a loading line, an error or an empty view. The
 *  Timeline's empty state, so the two read as one product. */
export function Notice({
  icon,
  title,
  children,
  action,
  footnote,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  footnote?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-8 py-6 text-center">
      {icon && <div className="mb-3 text-muted-foreground">{icon}</div>}
      {title && <h3 className="text-md font-medium text-foreground">{title}</h3>}
      {children && (
        <div
          className={cn(
            "max-w-[420px] text-sm leading-relaxed text-muted-foreground",
            title && "mt-1.5",
          )}
        >
          {children}
        </div>
      )}
      {action && <div className="mt-4 flex items-center justify-center gap-2">{action}</div>}
      {footnote && <p className="mt-3 max-w-[420px] text-xs text-disabled">{footnote}</p>}
    </div>
  );
}

/** A determinate progress hairline: the Usage bars' track and fill. */
export function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-element-selected">
      <div
        className="h-full rounded-full bg-secondary-foreground transition-[width] duration-base ease-out-strong"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** The sticky column-header row over a table, as the Usage tables draw it. */
export const TABLE_HEAD =
  "sticky top-0 z-panel flex h-control-md items-center border-b border-border bg-background px-3 text-3xs font-semibold uppercase tracking-wider text-muted-foreground";

/** A table row's rule. */
export const TABLE_ROW = "border-b border-border-subtle";

/** An expandable row's button: the hover wash, held while it is open. */
export function rowButton(expanded: boolean, className?: string): string {
  return cn(
    "flex h-9 w-full cursor-pointer items-center px-3 text-left transition-colors duration-fast ease-out-strong",
    expanded ? "bg-element-hover" : "hover:bg-element-hover",
    className,
  );
}

/** An expanded row's detail: one card-coloured step down from the row. */
export const ROW_DETAIL = "space-y-3 border-t border-border-subtle bg-card px-4 py-3";

/** The bordered well a detail's full text sits in. */
export const DETAIL_WELL = "rounded-md border border-border bg-background px-3 py-2";

/** Running text inside a `DETAIL_WELL`. */
export const DETAIL_TEXT =
  "whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-secondary-foreground";
