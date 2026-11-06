import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { KIND_LABEL } from "../../lib/shared-memory-format";
import {
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@tryatlas/design";

/* ── Primitives ──────────────────────────────────────────────────────────────── */

/** Dropdown column filter — "All …" + one entry per distinct value. On the
 *  house `DropdownMenu`: arrow keys, typeahead, Esc and outside-click
 *  dismissal, focus return, and the house menu look and motion. */
export function FilterMenu({
  label,
  value,
  options,
  onChange,
  format,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  format?: (v: string) => string;
}) {
  const active = !!value;
  const display = active ? (format ? format(value) : value) : label;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<FilterPill active={active} title={`Filter by ${label.toLowerCase()}`} />}
      >
        <span className="max-w-[120px] truncate">{display}</span>
        <ChevronDown
          size={10}
          className="shrink-0 text-muted-foreground transition-transform duration-fast group-data-popup-open:rotate-180"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} className="max-w-64">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => {
            if (next !== value) onChange(next as string);
          }}
        >
          <DropdownMenuRadioItem value="" closeOnClick>
            All {label.toLowerCase()}s
          </DropdownMenuRadioItem>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o} value={o} closeOnClick>
              <span className="min-w-0 truncate">{format ? format(o) : o}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The Usage facet pill a `FilterMenu` opens from: a round-ended hairline,
 *  stronger and filled once it narrows the list. An unfiltered pill holds
 *  its hover wash while its menu is open. The menu's trigger renders it and
 *  merges in its own props (handlers, ref, `data-popup-open`). */
function FilterPill({
  active,
  className,
  ...props
}: React.ComponentProps<"button"> & { active: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "group flex h-control-md cursor-pointer items-center gap-1 rounded-full border px-2 text-2xs font-medium",
        "transition-colors duration-fast ease-out-strong",
        active
          ? "border-border-strong bg-element-selected text-foreground"
          : "border-border text-secondary-foreground hover:bg-element-hover hover:text-foreground data-popup-open:bg-element-hover data-popup-open:text-foreground",
        className,
      )}
    />
  );
}

/** A memory kind's small label chip (the import dialog's rows). */
export function KindChip({ kind }: { kind: string }) {
  return (
    <Badge variant="outline" className="max-w-full">
      <span className="truncate">{KIND_LABEL[kind] ?? kind.replace(/_/g, " ")}</span>
    </Badge>
  );
}
