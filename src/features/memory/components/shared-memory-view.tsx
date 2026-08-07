// Shared Cross-Agent Memory (v2) — Memory panel "Shared" view.
//
// Surfaces the per-project shared event log so the user can see what every agent
// (Claude, Codex, …) is collectively working from. Two data tables — the full
// EVENT LOG and every PLAN captured — rendered in the same sticky-header,
// fixed-column-track style as the Settings ▸ API keys panel and the Atlas logs
// table (`CodexView` in memory-panel.tsx). Read-only mirror of the Rust event
// log; refresh re-reads it, clear wipes it.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  RefreshCw,
  Trash2,
  Search,
  ChevronRight,
  ChevronDown,
  Share2,
  ListChecks,
  ScrollText,
  ListFilter,
  Check,
} from "lucide-react";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { ClaudeIcon, CodexIcon } from "@/components/agent-icons";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import type { MemoryEvent } from "../lib/shared-memory-api";

interface Props {
  projectPath: string;
  className?: string;
}

type Tab = "events" | "plans";

/* ── Column tracks (sticky header + rows line up; min-width → horizontal scroll) ── */
const EVENT_COL = {
  seq: "w-[56px] shrink-0",
  time: "w-[92px] shrink-0",
  agent: "w-[128px] shrink-0",
  kind: "w-[136px] shrink-0",
  detail: "flex-1 min-w-[260px]",
  chevron: "w-[30px] shrink-0",
} as const;
const EVENT_MIN_W = 56 + 92 + 128 + 136 + 260 + 30;

const PLAN_COL = {
  seq: "w-[56px] shrink-0",
  time: "w-[92px] shrink-0",
  agent: "w-[128px] shrink-0",
  status: "w-[110px] shrink-0",
  plan: "flex-1 min-w-[280px]",
  chevron: "w-[30px] shrink-0",
} as const;
const PLAN_MIN_W = 56 + 92 + 128 + 110 + 280 + 30;

/* Per-agent identity — the one place DESIGN_PRINCIPLES sanctions color (§2.3). */
function agentMeta(agent: string): {
  Icon: typeof ClaudeIcon | null;
  tint: string;
  label: string;
} {
  const a = agent.toLowerCase();
  if (a.includes("codex"))
    return { Icon: CodexIcon, tint: "var(--agent-codex-chip-bg)", label: "Codex" };
  if (a.includes("claude"))
    return { Icon: ClaudeIcon, tint: "var(--agent-claude-chip-bg)", label: "Claude" };
  return { Icon: null, tint: "var(--bg-elevated)", label: agent.split(/[-_]/)[0] || agent };
}

const str = (v: unknown): string => (v == null ? "" : String(v));

/** One-line summary of an event's payload for the Detail column. */
function eventDetail(e: MemoryEvent): string {
  const p = e.payload ?? {};
  return str(p.text) || str(p.summary) || str(p.path) || str(e.key) || str(p.status) || "";
}

function eventTime(ts: number): string {
  if (!ts) return "—";
  return timeAgo(new Date(ts).toISOString(), { suffix: true });
}

function fmtDateTime(ts: number): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SharedMemoryView({ projectPath, className }: Props) {
  const events = useSharedMemoryStore.use.events();
  const loaded = useSharedMemoryStore.use.loaded();
  const { load, refresh, clear } = useSharedMemoryStore.use.actions();

  const [tab, setTab] = useState<Tab>("events");
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (projectPath) void load(projectPath);
  }, [projectPath, load]);

  const [agentFilter, setAgentFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>("");

  const plans = useMemo(() => events.filter((e) => e.kind === "plan_set"), [events]);

  // Filter options derived from the data actually present.
  const agentOptions = useMemo(() => [...new Set(events.map((e) => e.agent))].sort(), [events]);
  const kindOptions = useMemo(() => [...new Set(events.map((e) => e.kind))].sort(), [events]);

  const q = query.trim().toLowerCase();
  const baseMatch = (e: MemoryEvent) =>
    (!agentFilter || e.agent === agentFilter) &&
    (!q ||
      e.agent.toLowerCase().includes(q) ||
      e.kind.toLowerCase().includes(q) ||
      e.key.toLowerCase().includes(q) ||
      eventDetail(e).toLowerCase().includes(q));

  const eventRows = useMemo(
    () => events.filter((e) => baseMatch(e) && (!kindFilter || e.kind === kindFilter)),
    [events, q, agentFilter, kindFilter],
  );
  const planRows = useMemo(() => plans.filter(baseMatch), [plans, q, agentFilter]);

  return (
    <div className={cn("h-full flex flex-col bg-[var(--bg-base)]", className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border-default)]">
        {/* Events / Plans toggle — pill group, matches the Memory nav. */}
        <div className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)] p-0.5">
          <SegBtn
            active={tab === "events"}
            onClick={() => setTab("events")}
            icon={<ScrollText size={11} />}
            label="Events"
            count={events.length}
          />
          <SegBtn
            active={tab === "plans"}
            onClick={() => setTab("plans")}
            icon={<ListChecks size={11} />}
            label="Plans"
            count={plans.length}
          />
        </div>

        {/* Column filters */}
        <FilterMenu
          label="Agent"
          value={agentFilter}
          options={agentOptions}
          onChange={setAgentFilter}
          format={(a) => agentMeta(a).label}
        />
        {tab === "events" && (
          <FilterMenu
            label="Kind"
            value={kindFilter}
            options={kindOptions}
            onChange={setKindFilter}
            format={(k) => KIND_LABEL[k] ?? k.replace(/_/g, " ")}
          />
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1.5 h-6 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 w-[190px] focus-within:border-[var(--border-strong)]">
          <Search size={11} className="text-[var(--text-tertiary)] shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${tab}…`}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
          />
        </div>

        <IconButton label="Refresh" onClick={() => void refresh()}>
          <RefreshCw size={12} />
        </IconButton>
        <IconButton label="Clear shared memory" onClick={() => void clear()}>
          <Trash2 size={12} />
        </IconButton>
      </div>

      {/* Body */}
      {!loaded ? (
        <div className="p-3">
          <PanelSkeleton rows={8} />
        </div>
      ) : events.length === 0 ? (
        <EmptyState />
      ) : tab === "events" ? (
        <EventsTable rows={eventRows} />
      ) : (
        <PlansTable rows={planRows} />
      )}
    </div>
  );
}

/* ── Events table ────────────────────────────────────────────────────────────── */

function EventsTable({ rows }: { rows: MemoryEvent[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
      <div style={{ minWidth: EVENT_MIN_W }}>
        <HeaderRow>
          <span className={cn(EVENT_COL.seq, "tabular-nums")}>#</span>
          <span className={EVENT_COL.time}>Time</span>
          <span className={EVENT_COL.agent}>Agent</span>
          <span className={EVENT_COL.kind}>Kind</span>
          <span className={EVENT_COL.detail}>Detail</span>
          <span className={EVENT_COL.chevron} />
        </HeaderRow>
        {rows.length === 0 ? (
          <EmptyRows label="No events match." />
        ) : (
          rows.map((e) => (
            <EventRow
              key={e.seq}
              event={e}
              expanded={expanded === e.seq}
              onToggle={() => setExpanded((c) => (c === e.seq ? null : e.seq))}
            />
          ))
        )}
      </div>
    </div>
  );
}

function EventRow({
  event: e,
  expanded,
  onToggle,
}: {
  event: MemoryEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-b border-[var(--border-subtle)]">
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center h-[40px] px-3 text-left transition-colors cursor-pointer",
          expanded ? "bg-[var(--bg-elevated)]/50" : "hover:bg-[var(--bg-hover)]",
        )}
      >
        <span
          className={cn(
            EVENT_COL.seq,
            "font-mono text-[10px] tabular-nums text-[var(--text-ghost)]",
          )}
        >
          {e.seq}
        </span>
        <span className={cn(EVENT_COL.time, "text-[10px] text-[var(--text-tertiary)]")}>
          {eventTime(e.ts)}
        </span>
        <span className={EVENT_COL.agent}>
          <AgentMark agent={e.agent} />
        </span>
        <span className={EVENT_COL.kind}>
          <KindChip kind={e.kind} />
        </span>
        <span className={cn(EVENT_COL.detail, "min-w-0 pr-3")}>
          <span className="block truncate text-[12px] text-[var(--text-secondary)]">
            {eventDetail(e) || <span className="text-[var(--text-ghost)]">—</span>}
          </span>
        </span>
        <span
          className={cn(
            EVENT_COL.chevron,
            "flex items-center justify-end text-[var(--text-tertiary)]",
          )}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded && <EventDetail event={e} />}
    </div>
  );
}

function EventDetail({ event: e }: { event: MemoryEvent }) {
  const detail = eventDetail(e);
  return (
    <div className="bg-[var(--bg-elevated)]/40 border-t border-[var(--border-subtle)] px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <MetaChip label="Seq" value={`#${e.seq}`} mono />
        <MetaChip label="Kind" value={e.kind.replace(/_/g, " ")} />
        <MetaChip label="Agent" value={agentMeta(e.agent).label} />
        {e.key && <MetaChip label="Key" value={e.key} mono />}
        <MetaChip label="When" value={fmtDateTime(e.ts)} />
        {e.sessionId && <MetaChip label="Session" value={e.sessionId.slice(0, 8)} mono />}
      </div>
      {detail && (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.55] text-[var(--text-secondary)]">
            {detail}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── Plans table ─────────────────────────────────────────────────────────────── */

function PlansTable({ rows }: { rows: MemoryEvent[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <div className="flex-1 min-h-0 overflow-auto hide-scrollbar">
      <div style={{ minWidth: PLAN_MIN_W }}>
        <HeaderRow>
          <span className={cn(PLAN_COL.seq, "tabular-nums")}>#</span>
          <span className={PLAN_COL.time}>Time</span>
          <span className={PLAN_COL.agent}>Agent</span>
          <span className={PLAN_COL.status}>Status</span>
          <span className={PLAN_COL.plan}>Plan</span>
          <span className={PLAN_COL.chevron} />
        </HeaderRow>
        {rows.length === 0 ? (
          <EmptyRows label="No plans captured yet." />
        ) : (
          rows.map((e) => (
            <PlanRow
              key={e.seq}
              event={e}
              expanded={expanded === e.seq}
              onToggle={() => setExpanded((c) => (c === e.seq ? null : e.seq))}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PlanRow({
  event: e,
  expanded,
  onToggle,
}: {
  event: MemoryEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const text = str(e.payload?.text);
  const status = str(e.payload?.status) || "active";
  const firstLine = text.split("\n").find((l) => l.trim()) ?? "";
  return (
    <div className="border-b border-[var(--border-subtle)]">
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center h-[40px] px-3 text-left transition-colors cursor-pointer",
          expanded ? "bg-[var(--bg-elevated)]/50" : "hover:bg-[var(--bg-hover)]",
        )}
      >
        <span
          className={cn(
            PLAN_COL.seq,
            "font-mono text-[10px] tabular-nums text-[var(--text-ghost)]",
          )}
        >
          {e.seq}
        </span>
        <span className={cn(PLAN_COL.time, "text-[10px] text-[var(--text-tertiary)]")}>
          {eventTime(e.ts)}
        </span>
        <span className={PLAN_COL.agent}>
          <AgentMark agent={e.agent} />
        </span>
        <span className={PLAN_COL.status}>
          <StatusChip status={status} />
        </span>
        <span className={cn(PLAN_COL.plan, "min-w-0 pr-3")}>
          <span className="block truncate text-[12px] text-[var(--text-secondary)]">
            {firstLine || <span className="text-[var(--text-ghost)]">—</span>}
          </span>
        </span>
        <span
          className={cn(
            PLAN_COL.chevron,
            "flex items-center justify-end text-[var(--text-tertiary)]",
          )}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded && (
        <div className="bg-[var(--bg-elevated)]/40 border-t border-[var(--border-subtle)] px-4 py-3 space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <MetaChip label="Seq" value={`#${e.seq}`} mono />
            <MetaChip label="Status" value={status} />
            <MetaChip label="Agent" value={agentMeta(e.agent).label} />
            <MetaChip label="When" value={fmtDateTime(e.ts)} />
          </div>
          <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-2">
            <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.55] text-[var(--text-secondary)]">
              {text || "—"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Primitives ──────────────────────────────────────────────────────────────── */

function HeaderRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-[var(--border-default)] bg-[var(--bg-base)] px-3 text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
      {children}
    </div>
  );
}

function EmptyRows({ label }: { label: string }) {
  return (
    <div className="grid place-items-center h-[160px] text-[11px] text-[var(--text-tertiary)]">
      {label}
    </div>
  );
}

function SegBtn({
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
        "flex items-center gap-1.5 h-[20px] px-2.5 rounded-full text-[11px] font-medium transition-colors cursor-pointer",
        active
          ? "bg-[var(--bg-selected,var(--bg-hover))] text-[var(--text-primary)]"
          : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]",
      )}
    >
      <span className={active ? "opacity-100" : "opacity-60"}>{icon}</span>
      {label}
      {count > 0 && (
        <span className="text-[9px] tabular-nums text-[var(--text-ghost)]">{count}</span>
      )}
    </button>
  );
}

/** Dropdown column filter — "All …" + one entry per distinct value. */
function FilterMenu({
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
          "flex items-center gap-1 h-6 rounded-md border px-2 text-[11px] transition-colors cursor-pointer",
          active
            ? "border-[var(--border-strong)] bg-[var(--bg-elevated)] text-[var(--text-primary)]"
            : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)]",
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
        <div className="absolute top-full left-0 z-50 mt-1.5 max-h-[280px] min-w-[170px] overflow-y-auto hide-scrollbar rounded-lg border border-[var(--border-default)] bg-[var(--bg-elevated)] p-1 shadow-lg">
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
        "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11px] transition-colors cursor-pointer",
        active
          ? "bg-[var(--bg-selected,var(--bg-hover))] text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check size={11} className="shrink-0 text-[var(--accent-primary)]" />}
    </button>
  );
}

/** Tinted identity mark: agent logo on its sanctioned chip tint + short name. */
function AgentMark({ agent }: { agent: string }) {
  const { Icon, tint, label } = agentMeta(agent);
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-[var(--border-default)]"
        style={{ background: tint }}
      >
        {Icon ? (
          <Icon className="size-2.5" />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-tertiary)]" />
        )}
      </span>
      <span className="truncate font-mono text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">
        {label}
      </span>
    </span>
  );
}

const KIND_LABEL: Record<string, string> = {
  plan_set: "plan",
  decision: "decision",
  file_changed: "file",
  fact: "fact",
  session_start: "session start",
  session_end: "session end",
  todo_added: "todo +",
  todo_done: "todo ✓",
};

function KindChip({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center rounded bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[10px] text-[var(--text-tertiary)]">
      {KIND_LABEL[kind] ?? kind.replace(/_/g, " ")}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const done = /done|complete|closed/i.test(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]",
        done
          ? "bg-[var(--status-success-bg,var(--bg-elevated))] text-[var(--status-success,var(--text-tertiary))]"
          : "bg-[var(--bg-elevated)] text-[var(--text-tertiary)]",
      )}
    >
      {status}
    </span>
  );
}

function MetaChip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[9px] uppercase tracking-wider text-[var(--text-ghost)]">{label}</span>
      <span
        className={cn("text-[11px] text-[var(--text-secondary)]", mono && "font-mono text-[10px]")}
      >
        {value}
      </span>
    </span>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded-md border border-[var(--border-default)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] active:scale-[0.96]"
    >
      {children}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] text-[var(--text-tertiary)]">
        <Share2 size={16} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium text-[var(--text-secondary)]">
          No shared memory yet
        </span>
        <p className="max-w-[34ch] text-[12px] leading-[1.5] text-[var(--text-tertiary)]">
          As agents plan, decide, and edit files, their work is captured here as events and shared
          with every agent on this project.
        </p>
      </div>
    </div>
  );
}
