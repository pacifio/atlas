import { useMemo, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
import { Check, ChevronsUpDown, Search } from "lucide-react";

export interface ComboOption {
  value: string;
  label: string;
  /** Optional secondary line shown under the label. */
  hint?: string;
  /** Optional leading icon. */
  icon?: ReactNode;
}

interface Props {
  value: string | null;
  options: ComboOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  /** Text shown while there are no options (e.g. "Loading…"). */
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
}

/** A compact, searchable combo box built on radix Popover — a prettier,
 *  filterable replacement for a native <select>. */
export function Combobox({
  value,
  options,
  onChange,
  placeholder = "Select…",
  emptyLabel = "No options",
  disabled,
  className,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        o.hint?.toLowerCase().includes(q),
    );
  }, [options, query]);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (disabled) return;
        setOpen(o);
        if (o) {
          setQuery("");
          // Focus the search box once the panel mounts.
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex items-center gap-1.5 w-full min-w-0 rounded-md border border-border-default bg-bg-selected/40 px-2 py-1.5 text-left",
            "hover:bg-bg-hover transition-colors cursor-pointer outline-none",
            "focus-visible:border-border-focus disabled:opacity-40 disabled:cursor-default",
            className,
          )}
        >
          {selected?.icon}
          <span
            className={cn(
              "flex-1 min-w-0 truncate text-[11px]",
              selected ? "text-text-primary" : "text-text-tertiary",
            )}
          >
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown size={12} className="text-text-tertiary shrink-0" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className={cn(
            "z-50 w-[var(--radix-popover-trigger-width)] min-w-[180px] rounded-lg border border-border-default",
            "bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)] overflow-hidden",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <div className="flex items-center gap-1.5 px-2 h-8 border-b border-border-default">
            <Search size={12} className="text-text-tertiary shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="flex-1 min-w-0 bg-transparent text-[11px] text-text-primary placeholder:text-text-tertiary outline-none"
            />
          </div>
          <div className="max-h-[240px] overflow-auto hide-scrollbar py-1">
            {filtered.length === 0 ? (
              <div className="px-2 py-3 text-center text-[11px] text-text-tertiary">
                {options.length === 0 ? emptyLabel : "No matches"}
              </div>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex items-center gap-1.5 w-full px-2 py-1.5 text-left cursor-pointer transition-colors",
                    o.value === value ? "bg-bg-selected" : "hover:bg-bg-hover",
                  )}
                >
                  {o.icon}
                  <span className="flex-1 min-w-0">
                    <span className="block truncate text-[11px] text-text-primary">{o.label}</span>
                    {o.hint && (
                      <span className="block truncate text-[10px] text-text-tertiary">
                        {o.hint}
                      </span>
                    )}
                  </span>
                  {o.value === value && (
                    <Check size={12} className="text-text-secondary shrink-0" />
                  )}
                </button>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
