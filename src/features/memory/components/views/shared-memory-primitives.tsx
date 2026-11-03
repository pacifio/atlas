import { useEffect, useRef, useState } from "react";
import { ChevronDown, ListFilter, Check, Share2 } from "lucide-react";
import { AgentMark } from "@/components/agent-mark";
import { agentMetaForSource, pluginIdForSource } from "../../lib/memory-agent";
import { cn } from "@/lib/utils";
import { HintItem } from "@/ui/hint-group";
import { KIND_LABEL, sourceLabel } from "../../lib/shared-memory-format";

/* ── Primitives ──────────────────────────────────────────────────────────────── */

export function HeaderRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-[var(--border)] bg-[var(--background)] px-3 text-2xs uppercase tracking-wider text-[var(--muted-foreground)]">
      {children}
    </div>
  );
}

export function EmptyRows({ label }: { label: string }) {
  return (
    <div className="grid place-items-center h-[160px] text-xs text-[var(--muted-foreground)]">
      {label}
    </div>
  );
}

export function SegBtn({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 h-control-xs px-2.5 rounded-full text-xs font-medium transition-colors cursor-pointer",
        active
          ? "bg-[var(--atlas-element-selected,var(--atlas-element-hover))] text-[var(--foreground)]"
          : "text-[var(--muted-foreground)] hover:text-[var(--secondary-foreground)]",
      )}
    >
      <span className={active ? "opacity-100" : "opacity-60"}>{icon}</span>
      {label}
      {count > 0 && (
        <span className="text-3xs tabular-nums text-[var(--atlas-text-disabled)]">{count}</span>
      )}
    </button>
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
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Filter by ${label.toLowerCase()}`}
        className={cn(
          "flex items-center gap-1 h-6 rounded-md border px-2 text-xs transition-colors cursor-pointer",
          active
            ? "border-[var(--atlas-border-strong)] bg-[var(--card)] text-[var(--foreground)]"
            : "border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--secondary-foreground)]",
        )}
      >
        <ListFilter size={11} className="shrink-0" />
        <span className="max-w-[120px] truncate">{display}</span>
        <ChevronDown
          size={10}
          className={cn("shrink-0 opacity-50 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="absolute top-full left-0 z-popover mt-1.5 max-h-[280px] min-w-[170px] overflow-y-auto hide-scrollbar rounded-lg border border-[var(--border)] bg-[var(--card)] p-1 shadow-lg">
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
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors cursor-pointer",
        active
          ? "bg-[var(--atlas-element-selected,var(--atlas-element-hover))] text-[var(--foreground)]"
          : "text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)]",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={11} className="shrink-0 text-[var(--primary)]" />}
    </button>
  );
}

/** Identity mark: the agent's badge (brand glyph, registry icon, or monogram)
 *  plus its resolved name. */
export function AgentTag({ agent }: { agent: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <AgentMark agentType={pluginIdForSource(agent)} />
      <span className="truncate font-mono text-2xs uppercase tracking-wider text-[var(--muted-foreground)]">
        {agentMetaForSource(agent).label}
      </span>
    </span>
  );
}

/** The table's small label chip (kind, source). */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded bg-[var(--card)] px-1.5 py-0.5 text-2xs text-[var(--muted-foreground)]">
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A candidate or archived entry's state, beside its source. */
export function StateChip({ state }: { state: string }) {
  return (
    <span className="text-3xs uppercase tracking-wide text-[var(--muted-foreground)] border border-[var(--border)] rounded px-1 py-px">
      {state}
    </span>
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
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs",
        done
          ? "bg-[var(--atlas-status-success-background,var(--card))] text-[var(--atlas-status-success-foreground,var(--muted-foreground))]"
          : "bg-[var(--card)] text-[var(--muted-foreground)]",
      )}
    >
      {status}
    </span>
  );
}

export function MetaChip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-3xs uppercase tracking-wider text-[var(--atlas-text-disabled)]">
        {label}
      </span>
      <span
        className={cn("text-xs text-[var(--secondary-foreground)]", mono && "font-mono text-2xs")}
      >
        {value}
      </span>
    </span>
  );
}

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
        className="flex h-6 w-6 items-center justify-center rounded-md border border-[var(--border)] text-[var(--muted-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] active:scale-[0.96]"
      >
        {children}
      </button>
    </HintItem>
  );
}

export function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)]">
        <Share2 size={16} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-base font-medium text-[var(--secondary-foreground)]">
          No shared memory yet
        </span>
        <p className="max-w-[34ch] text-sm leading-[1.5] text-[var(--muted-foreground)]">
          As agents plan, decide, and edit files, their work is captured here as events and shared
          with every agent on this project.
        </p>
      </div>
    </div>
  );
}
