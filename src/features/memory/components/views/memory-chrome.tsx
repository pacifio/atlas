// The Memory surface's shared chrome, props-only: the toolbar strip, the
// round-ended track its one-of-N switches sit in, the search field, the
// centred notice every gate and empty state uses, and the table header.
//
// Drawn in the Usage and Timeline grammar: achromatic surfaces, hairline
// borders, no fills behind a track, a selected segment as the element ramp's
// selected step. Each piece used to be restated per view, in four slightly
// different heights and radii.

import { useRef, type ReactNode } from "react";
import { MessageSquarePlus, Search, X } from "lucide-react";
import { Button, KbdKeys } from "@tryatlas/design";
import { askKeyAction } from "@/features/ask-agent/lib/ask-box-keys";
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

/** A way into the ask box that reads as a field: what to ask, and an example
 *  of it. It is a button, not an input: the box opens from it, so the words,
 *  the chosen session and ⌘↵ are the same as everywhere else. */
export function AskField({
  label,
  hint,
  onOpen,
  className,
}: {
  label: string;
  hint?: string;
  onOpen: (anchor: HTMLElement) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => onOpen(e.currentTarget)}
      className={cn(
        "flex h-control-md w-full min-w-0 cursor-text items-center gap-1.5 rounded border border-border bg-panel-input px-2 text-left text-xs text-muted-foreground",
        "transition-colors duration-fast ease-out-strong hover:border-border-strong hover:text-secondary-foreground",
        className,
      )}
    >
      <MessageSquarePlus aria-hidden className="size-3 shrink-0" />
      <span className="shrink-0">{label}</span>
      {/* An example, not part of the button's name. */}
      {hint ? (
        <span aria-hidden className="min-w-0 truncate text-disabled">
          {hint}
        </span>
      ) : null}
    </button>
  );
}

/**
 * A tab's one field: typing filters the list, and ⌘↵ (or the button) hands
 * the words to the agent as a memory instruction, through the ask box.
 * Telling the agent is the main way memory changes, so its button stays on
 * the field rather than behind the keys.
 */
export function SearchAskField({
  value,
  onChange,
  placeholder,
  label,
  askKeys,
  onAsk,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** The field's accessible name ("Search memories"). */
  label: string;
  /** Keycaps for the ask (["⌘", "↵"], ["Ctrl", "↵"]). */
  askKeys: readonly string[];
  /** `anchor`: the field, which the ask box opens against. */
  onAsk: (text: string, anchor: HTMLElement) => void;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const ask = (fallback: HTMLElement) => onAsk(value.trim(), fieldRef.current ?? fallback);
  return (
    // The buttons sit outside the <label>, which would otherwise name them.
    <div
      ref={fieldRef}
      className="flex h-control-md min-w-40 flex-1 items-center gap-1 rounded border border-border bg-panel-input pe-0.5 focus-within:border-border-strong"
    >
      <label className="flex h-full min-w-0 flex-1 cursor-text items-center gap-1.5 ps-2">
        <Search aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && value) {
              e.preventDefault();
              onChange("");
              return;
            }
            const action = askKeyAction({
              key: e.key,
              metaKey: e.metaKey,
              ctrlKey: e.ctrlKey,
              shiftKey: e.shiftKey,
              altKey: e.altKey,
              isComposing: e.nativeEvent.isComposing || e.keyCode === 229,
            });
            if (action !== "send") return;
            e.preventDefault();
            ask(e.currentTarget);
          }}
          placeholder={placeholder}
          aria-label={label}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X aria-hidden className="size-3" />
        </button>
      ) : null}
      <Button size="xs" variant="ghost" onClick={(e) => ask(e.currentTarget)}>
        <MessageSquarePlus aria-hidden className="size-3" />
        Ask agent
        <KbdKeys keys={askKeys} />
      </Button>
    </div>
  );
}

/** The panel's prompt line, above the tabs that have no list to search:
 *  where the user tells the agent what to remember or forget. */
export function PromptLine({ onOpen }: { onOpen: (anchor: HTMLElement) => void }) {
  return (
    <div className="shrink-0 border-b border-border px-2 py-1.5">
      <AskField label="Tell the agent what to remember or forget…" onOpen={onOpen} />
    </div>
  );
}
