import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { AgentMark } from "@/components/agent-mark";
import { agentMetaForSource, pluginIdForSource } from "../../lib/memory-agent";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
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

/** Dropdown column filter — "All …" + one entry per distinct value. */
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
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = !!value;
  const display = active ? (format ? format(value) : value) : label;

  return (
    <div ref={ref} className="relative">
      {/* The Usage facet pill: a round-ended hairline, stronger and filled
          once it narrows the table. */}
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Filter by ${label.toLowerCase()}`}
        className={cn(
          "flex h-control-sm cursor-pointer items-center gap-1 rounded-full border px-2 text-2xs font-medium",
          "transition-colors duration-fast ease-out-strong",
          active
            ? "border-border-strong bg-element-selected text-foreground"
            : "border-border text-secondary-foreground hover:bg-element-hover hover:text-foreground",
        )}
      >
        <span className="max-w-[120px] truncate">{display}</span>
        <ChevronDown
          size={10}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-fast",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="hide-scrollbar absolute top-full left-0 z-popover mt-1.5 max-h-[280px] min-w-[170px] animate-scale-in overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-md">
          <FilterOption
            label={`All ${label.toLowerCase()}s`}
            active={!value}
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          />
          {options.map((o) => (
            <FilterOption
              key={o}
              label={format ? format(o) : o}
              active={value === o}
              onClick={() => {
                onChange(o);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterOption({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-control-md w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs",
        "transition-colors duration-fast ease-out-strong",
        active
          ? "text-foreground"
          : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={11} className="shrink-0 text-foreground" />}
    </button>
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
