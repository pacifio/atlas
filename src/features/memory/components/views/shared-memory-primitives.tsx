import { ChevronDown } from "lucide-react";
import { AgentMark } from "@/components/agent-mark";
import { agentMetaForSource, pluginIdForSource } from "../../lib/memory-agent";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { iconButtonVariants } from "@/ui/icon-button";
import { HintItem } from "@/ui/hint-group";
import { KIND_LABEL, sourceLabel } from "../../lib/shared-memory-format";
import { Notice, TABLE_HEAD, TrackSegment } from "./memory-chrome";

/* ── Primitives ──────────────────────────────────────────────────────────────── */

export function HeaderRow({ children }: { children: React.ReactNode }) {
  return <div className={TABLE_HEAD}>{children}</div>;
}

export function EmptyRows({ label }: { label: string }) {
  return (
    <div className="grid h-[160px] place-items-center text-xs text-muted-foreground">{label}</div>
  );
}

/** One of the Shared view's table switches, with its row count. */
export function SegBtn({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <TrackSegment active={active} onClick={onClick}>
      {label}
      {count > 0 && (
        <span
          className={cn(
            "text-3xs tabular-nums",
            active ? "text-muted-foreground" : "text-disabled",
          )}
        >
          {count}
        </span>
      )}
    </TrackSegment>
  );
}

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
 *  stronger and filled once it narrows the table. An unfiltered pill holds
 *  its hover wash while its menu is open. The menu's trigger renders it and merges in its
 *  own props (handlers, ref, `data-popup-open`). */
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
        "group flex h-control-sm cursor-pointer items-center gap-1 rounded-full border px-2 text-2xs font-medium",
        "transition-colors duration-fast ease-out-strong",
        active
          ? "border-border-strong bg-element-selected text-foreground"
          : "border-border text-secondary-foreground hover:bg-element-hover hover:text-foreground data-popup-open:bg-element-hover data-popup-open:text-foreground",
        className,
      )}
    />
  );
}

/** Identity mark: the agent's badge (brand glyph, registry icon, or monogram)
 *  plus its resolved name. */
export function AgentTag({ agent }: { agent: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <AgentMark agentType={pluginIdForSource(agent)} />
      <span className="truncate text-xs text-secondary-foreground">
        {agentMetaForSource(agent).label}
      </span>
    </span>
  );
}

/** The table's small label chip (kind, source). */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="outline" className="max-w-full">
      <span className="truncate">{children}</span>
    </Badge>
  );
}

/** A candidate or archived entry's state, beside its source. */
export function StateChip({ state }: { state: string }) {
  return (
    <Badge variant="secondary" size="sm">
      <span className="uppercase tracking-wide">{state}</span>
    </Badge>
  );
}

export function KindChip({ kind }: { kind: string }) {
  return <Chip>{KIND_LABEL[kind] ?? kind.replace(/_/g, " ")}</Chip>;
}

/** An entry's source, in the same chip as its kind. */
export function SourceChip({ source }: { source: string }) {
  return <Chip>{sourceLabel(source)}</Chip>;
}

export function StatusChip({ status }: { status: string }) {
  const done = /done|complete|closed/i.test(status);
  return <Badge variant={done ? "success" : "outline"}>{status}</Badge>;
}

export function MetaChip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-3xs font-semibold uppercase tracking-wider text-disabled">{label}</span>
      <span className={cn("text-xs text-secondary-foreground", mono && "font-mono text-2xs")}>
        {value}
      </span>
    </span>
  );
}

/** A glyph action with its hint — `IconButton`'s hairline square on a plain
 *  button, so a caller can swap the glyph (a save becoming its spinner). */
export function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <HintItem label={label}>
      <button
        type="button"
        onClick={onClick}
        className={iconButtonVariants({ variant: "hairline", size: "sm" })}
      >
        {children}
      </button>
    </HintItem>
  );
}

export function EmptyState() {
  return (
    <Notice title="No shared memory yet">
      As agents plan, decide, and edit files, their work is captured here as events and shared with
      every agent on this project.
    </Notice>
  );
}
