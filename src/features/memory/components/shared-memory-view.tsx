// Shared Cross-Agent Memory (v2) — Memory panel "Shared" view.
//
// Surfaces the per-project shared event log so the user can see what every agent
// (Claude, Codex, …) is collectively working from. Two data tables — the full
// EVENT LOG and every PLAN captured — rendered in the same sticky-header,
// fixed-column-track style as the Settings ▸ API keys panel and the Atlas logs
// table (`CodexView` in memory-panel.tsx). Read-only mirror of the Rust event
// log; refresh re-reads it, clear wipes it.
//
// A third table, MEMORIES, lists every record entry with its provenance (the
// source: an agent, the extractor, the user or an import; and the agent) and
// its confidence. An expanded row edits the entry in place (the Policy view's
// draft/save/revert pattern) or forgets it behind the file tree's confirm
// dialog; both write through the backend, which announces the change.
//
// The toolbar's import action pulls the project's Claude auto-memory in: a
// dialog (the Import sessions modal's shell) previews every mapped line with
// its kind, and only its Import button writes — Cancel writes nothing.

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
  Brain,
  Pencil,
  X,
  Loader2,
  Download,
  Eraser,
  Inbox,
  FolderInput,
} from "lucide-react";
import { Dialog } from "@base-ui/react/dialog";
import { DialogOverlay } from "@/ui/dialog";
import { toast } from "sonner";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { AgentMark } from "@/components/agent-mark";
import { agentMetaForSource, pluginIdForSource } from "../lib/memory-agent";
import { timeAgo } from "@/lib/time-ago";
import { cn } from "@/lib/utils";
import { MemoryReviewView } from "./memory-review-view";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { useMemoryStore } from "../stores/memory-store";
import { sharedMemory } from "../lib/shared-memory-api";
import type {
  ClaudeImportLine,
  ClaudeImportPreview,
  ExportPreview,
  MemoryEntry,
  RepoImportLine,
  MemoryEvent,
  Provenance,
} from "../lib/shared-memory-api";
import { formatDateTime } from "@/lib/format-time";

interface Props {
  projectPath: string;
  className?: string;
}

type Tab = "events" | "plans" | "memories" | "review";

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

const ENTRY_COL = {
  time: "w-[92px] shrink-0",
  kind: "w-[110px] shrink-0",
  source: "w-[120px] shrink-0",
  agent: "w-[128px] shrink-0",
  confidence: "w-[64px] shrink-0 text-right pr-4",
  content: "flex-1 min-w-[240px]",
  chevron: "w-[30px] shrink-0",
} as const;
const ENTRY_MIN_W = 92 + 110 + 120 + 128 + 64 + 240 + 30;

/* Agent identity resolves through the registry chokepoint (`agentMeta`), so an
 * agent installed from the ACP registry gets its real name and manifest icon
 * instead of a truncated id. The local resolver this replaced knew only Claude
 * and Codex, which is how one agent could render twice under two identities. */

const str = (v: unknown): string => (v == null ? "" : String(v));

/** One-line summary of an event's payload for the Detail column. */
function eventDetail(e: MemoryEvent): string {
  const p = e.payload ?? {};
  return str(p.text) || str(p.summary) || str(p.path) || str(e.key) || str(p.status) || "";
}

/** Where an entry came from: the extractor, the user, an import (with its
 *  origin), or the agent that wrote it. */
export function sourceLabel(source: string): string {
  if (!source) return "—";
  if (source === "extractor" || source === "user") return source;
  if (source.startsWith("import:")) return `import · ${source.slice("import:".length)}`;
  return agentMetaForSource(source).label;
}

/** The entry's agent as a name: an import has none, and a user edit is the
 *  user's, not an agent's. `null` = not an agent. */
function entryAgent(agent: string): string | null {
  return agent && agent !== "user" ? agent : null;
}

/** A 0–1 confidence as a whole percentage. */
export function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function eventTime(ts: number): string {
  if (!ts) return "—";
  return timeAgo(new Date(ts).toISOString(), { suffix: true });
}

function fmtDateTime(ts: number): string {
  if (!ts) return "—";
  return formatDateTime(ts, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SharedMemoryView({ projectPath, className }: Props) {
  const events = useSharedMemoryStore.use.events();
  const entries = useSharedMemoryStore.use.entries();
  const loaded = useSharedMemoryStore.use.loaded();
  const { load, refresh, clear } = useSharedMemoryStore.use.actions();

  const [tab, setTab] = useState<Tab>("events");
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [importingRepo, setImportingRepo] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const clearConfirmed = async () => {
    setConfirmClear(false);
    try {
      await clear();
    } catch (err) {
      toast.error(
        `Couldn't clear shared memory: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  useEffect(() => {
    if (projectPath) void load(projectPath);
  }, [projectPath, load]);

  const [agentFilter, setAgentFilter] = useState<string>("");
  const [kindFilter, setKindFilter] = useState<string>("");

  // Asked to open an entry ("Memory updated" card): show the Memories table
  // unfiltered, so the row is there for the table to expand.
  const focusEntryId = useMemoryStore.use.focusEntryId();
  useEffect(() => {
    if (focusEntryId == null) return;
    setTab("memories");
    setQuery("");
    setAgentFilter("");
    setKindFilter("");
  }, [focusEntryId]);

  const plans = useMemo(() => events.filter((e) => e.kind === "plan_set"), [events]);

  // Filter options derived from the data actually present.
  const agentOptions = useMemo(
    () =>
      tab === "memories"
        ? [...new Set(entries.map((e) => e.agent).filter(Boolean))].sort()
        : [...new Set(events.map((e) => e.agent))].sort(),
    [events, entries, tab],
  );
  const kindOptions = useMemo(
    () =>
      tab === "memories"
        ? [...new Set(entries.map((e) => e.kind))].sort()
        : [...new Set(events.map((e) => e.kind))].sort(),
    [events, entries, tab],
  );
  // A filter value from the other table matches nothing here: start clean.
  useEffect(() => {
    setAgentFilter("");
    setKindFilter("");
  }, [tab]);

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
  const entryRows = useMemo(
    () =>
      entries.filter(
        (e) =>
          (!agentFilter || e.agent === agentFilter) &&
          (!kindFilter || e.kind === kindFilter) &&
          (!q ||
            e.content.toLowerCase().includes(q) ||
            e.key.toLowerCase().includes(q) ||
            e.kind.toLowerCase().includes(q) ||
            sourceLabel(e.source).toLowerCase().includes(q) ||
            e.agent.toLowerCase().includes(q)),
      ),
    [entries, q, agentFilter, kindFilter],
  );

  return (
    <div className={cn("h-full flex flex-col bg-[var(--background)]", className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border)]">
        {/* Events / Plans toggle — pill group, matches the Memory nav. */}
        <div className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border)] bg-[var(--card)] p-0.5">
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
          <SegBtn
            active={tab === "memories"}
            onClick={() => setTab("memories")}
            icon={<Brain size={11} />}
            label="Memories"
            count={entries.length}
          />
          <SegBtn
            active={tab === "review"}
            onClick={() => setTab("review")}
            icon={<Inbox size={11} />}
            label="Review"
            count={0}
          />
        </div>

        {/* Column filters */}
        <FilterMenu
          label="Agent"
          value={agentFilter}
          options={agentOptions}
          onChange={setAgentFilter}
          format={(a) => (tab === "memories" && !entryAgent(a) ? a : agentMetaForSource(a).label)}
        />
        {tab !== "plans" && (
          <FilterMenu
            label="Kind"
            value={kindFilter}
            options={kindOptions}
            onChange={setKindFilter}
            format={(k) => KIND_LABEL[k] ?? k.replace(/_/g, " ")}
          />
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1.5 h-6 rounded-md border border-[var(--border)] bg-[var(--card)] px-2 w-[190px] focus-within:border-[var(--atlas-border-strong)]">
          <Search size={11} className="text-[var(--muted-foreground)] shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${tab}…`}
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
          />
        </div>

        <HintGroup>
          <IconButton label="Refresh" onClick={() => void refresh()}>
            <RefreshCw size={12} />
          </IconButton>
          <IconButton label="Import Claude memory" onClick={() => setImporting(true)}>
            <Download size={12} />
          </IconButton>
          <IconButton label="Import memory repo" onClick={() => setImportingRepo(true)}>
            <FolderInput size={12} />
          </IconButton>
          <IconButton label="Clear shared memory" onClick={() => setConfirmClear(true)}>
            <Trash2 size={12} />
          </IconButton>
        </HintGroup>
      </div>
      <ImportClaudeMemoryModal
        open={importing}
        onOpenChange={setImporting}
        onImported={() => setTab("memories")}
      />
      <ImportRepoModal
        projectPath={projectPath}
        open={importingRepo}
        onOpenChange={setImportingRepo}
        onImported={() => {
          setTab("review");
          void refresh();
        }}
      />
      <FileTreeConfirmDelete
        open={confirmClear}
        name="shared memory"
        isDir={false}
        title="Clear shared memory?"
        body="Every agent on this project loses every plan, decision, fact, failure and architecture note recorded here. This can't be undone."
        confirmLabel="Clear"
        onConfirm={() => void clearConfirmed()}
        onOpenChange={setConfirmClear}
      />

      {/* Body */}
      {tab === "review" ? (
        <MemoryReviewView projectPath={projectPath} />
      ) : !loaded ? (
        <div className="p-3">
          <PanelSkeleton rows={8} />
        </div>
      ) : (tab === "memories" ? entries.length === 0 : events.length === 0) ? (
        <EmptyState />
      ) : tab === "events" ? (
        <EventsTable rows={eventRows} />
      ) : tab === "plans" ? (
        <PlansTable rows={planRows} />
      ) : (
        <MemoriesTable rows={entryRows} />
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
    <div className="border-b border-[var(--atlas-border-subtle)]">
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center h-[40px] px-3 text-left transition-colors cursor-pointer",
          expanded ? "bg-[var(--card)]/50" : "hover:bg-[var(--atlas-element-hover)]",
        )}
      >
        <span
          className={cn(
            EVENT_COL.seq,
            "font-mono text-2xs tabular-nums text-[var(--atlas-text-disabled)]",
          )}
        >
          {e.seq}
        </span>
        <span className={cn(EVENT_COL.time, "text-2xs text-[var(--muted-foreground)]")}>
          {eventTime(e.ts)}
        </span>
        <span className={EVENT_COL.agent}>
          <AgentTag agent={e.agent} />
        </span>
        <span className={EVENT_COL.kind}>
          <KindChip kind={e.kind} />
        </span>
        <span className={cn(EVENT_COL.detail, "min-w-0 pr-3")}>
          <span className="block truncate text-sm text-[var(--secondary-foreground)]">
            {eventDetail(e) || <span className="text-[var(--atlas-text-disabled)]">—</span>}
          </span>
        </span>
        <span
          className={cn(
            EVENT_COL.chevron,
            "flex items-center justify-end text-[var(--muted-foreground)]",
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
    <div className="bg-[var(--card)]/40 border-t border-[var(--atlas-border-subtle)] px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <MetaChip label="Seq" value={`#${e.seq}`} mono />
        <MetaChip label="Kind" value={e.kind.replace(/_/g, " ")} />
        <MetaChip label="Agent" value={agentMetaForSource(e.agent).label} />
        {e.key && <MetaChip label="Key" value={e.key} mono />}
        <MetaChip label="When" value={fmtDateTime(e.ts)} />
        {e.sessionId && <MetaChip label="Session" value={e.sessionId.slice(0, 8)} mono />}
      </div>
      {detail && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-[1.55] text-[var(--secondary-foreground)]">
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
    <div className="border-b border-[var(--atlas-border-subtle)]">
      <button
        onClick={onToggle}
        className={cn(
          "w-full flex items-center h-[40px] px-3 text-left transition-colors cursor-pointer",
          expanded ? "bg-[var(--card)]/50" : "hover:bg-[var(--atlas-element-hover)]",
        )}
      >
        <span
          className={cn(
            PLAN_COL.seq,
            "font-mono text-2xs tabular-nums text-[var(--atlas-text-disabled)]",
          )}
        >
          {e.seq}
        </span>
        <span className={cn(PLAN_COL.time, "text-2xs text-[var(--muted-foreground)]")}>
          {eventTime(e.ts)}
        </span>
        <span className={PLAN_COL.agent}>
          <AgentTag agent={e.agent} />
        </span>
        <span className={PLAN_COL.status}>
          <StatusChip status={status} />
        </span>
        <span className={cn(PLAN_COL.plan, "min-w-0 pr-3")}>
          <span className="block truncate text-sm text-[var(--secondary-foreground)]">
            {firstLine || <span className="text-[var(--atlas-text-disabled)]">—</span>}
          </span>
        </span>
        <span
          className={cn(
            PLAN_COL.chevron,
            "flex items-center justify-end text-[var(--muted-foreground)]",
          )}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {expanded && (
        <div className="bg-[var(--card)]/40 border-t border-[var(--atlas-border-subtle)] px-4 py-3 space-y-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <MetaChip label="Seq" value={`#${e.seq}`} mono />
            <MetaChip label="Status" value={status} />
            <MetaChip label="Agent" value={agentMetaForSource(e.agent).label} />
            <MetaChip label="When" value={fmtDateTime(e.ts)} />
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-[1.55] text-[var(--secondary-foreground)]">
              {text || "—"}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Memories table ──────────────────────────────────────────────────────────── */

const DURABLE_KINDS: ReadonlySet<string> = new Set([
  "decision",
  "fact",
  "failure",
  "architecture",
  "preference",
]);

/** Whether an entry can go into AGENTS.md: an active durable memory. A
 *  candidate is unreviewed, and the backend refuses plans, file changes and
 *  archived entries. */
function exportable(e: MemoryEntry): boolean {
  return e.state === "active" && DURABLE_KINDS.has(e.kind);
}

function MemoriesTable({ rows }: { rows: MemoryEntry[] }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const focusEntryId = useMemoryStore.use.focusEntryId();
  const { clearFocusEntry } = useMemoryStore.use.actions();
  // Expand the entry asked for once its row is listed, then consume the ask.
  useEffect(() => {
    if (focusEntryId == null || !rows.some((r) => r.id === focusEntryId)) return;
    setExpanded(focusEntryId);
    clearFocusEntry();
    scroller.current
      ?.querySelector(`[data-entry-id="${focusEntryId}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [focusEntryId, rows, clearFocusEntry]);
  const toggle = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // In the order picked; a row filtered out of view, or no longer
  // exportable, is not exported.
  const chosen = [...selected].filter((id) => rows.some((r) => r.id === id && exportable(r)));
  return (
    <div ref={scroller} className="flex-1 min-h-0 overflow-auto hide-scrollbar">
      {chosen.length > 0 && (
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted-foreground)]">
          <span>{chosen.length} selected</span>
          <button
            type="button"
            onClick={() => setExporting(true)}
            className="ml-auto h-6 rounded-md border border-[var(--border)] px-2 text-xs text-[var(--secondary-foreground)] transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
          >
            Export to AGENTS.md
          </button>
        </div>
      )}
      <ExportAgentsModal
        open={exporting}
        ids={chosen}
        onOpenChange={setExporting}
        onWritten={() => setSelected(new Set())}
      />
      <div style={{ minWidth: ENTRY_MIN_W }}>
        <HeaderRow>
          <span className="w-6 shrink-0" />
          <span className={ENTRY_COL.time}>Updated</span>
          <span className={ENTRY_COL.kind}>Kind</span>
          <span className={ENTRY_COL.source}>Source</span>
          <span className={ENTRY_COL.agent}>Agent</span>
          <span className={ENTRY_COL.confidence}>Conf.</span>
          <span className={ENTRY_COL.content}>Memory</span>
          <span className={ENTRY_COL.chevron} />
        </HeaderRow>
        {rows.length === 0 ? (
          <EmptyRows label="No memories match." />
        ) : (
          rows.map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              expanded={expanded === e.id}
              onToggle={() => setExpanded((c) => (c === e.id ? null : e.id))}
              selected={selected.has(e.id)}
              onSelect={() => toggle(e.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function EntryRow({
  entry: e,
  expanded,
  onToggle,
  selected,
  onSelect,
}: {
  entry: MemoryEntry;
  expanded: boolean;
  onToggle: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div data-entry-id={e.id} className="border-b border-[var(--atlas-border-subtle)]">
      <div className="flex items-center">
        <span className="flex w-6 shrink-0 items-center justify-end">
          {exportable(e) && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onSelect}
              aria-label={`Select ${e.content}`}
              className="h-3 w-3 cursor-pointer accent-[var(--primary)]"
            />
          )}
        </span>
        <button
          onClick={onToggle}
          className={cn(
            "flex-1 min-w-0 flex items-center h-[40px] px-3 text-left transition-colors cursor-pointer",
            expanded ? "bg-[var(--card)]/50" : "hover:bg-[var(--atlas-element-hover)]",
          )}
        >
          <span className={cn(ENTRY_COL.time, "text-2xs text-[var(--muted-foreground)]")}>
            {eventTime(e.updatedAt)}
          </span>
          <span className={ENTRY_COL.kind}>
            <KindChip kind={e.kind} />
          </span>
          <span className={cn(ENTRY_COL.source, "min-w-0 pr-2 flex items-center gap-1")}>
            <SourceChip source={e.source} />
            {e.state && e.state !== "active" && <StateChip state={e.state} />}
          </span>
          <span className={cn(ENTRY_COL.agent, "min-w-0")}>
            {entryAgent(e.agent) ? (
              <AgentTag agent={e.agent} />
            ) : (
              <span className="font-mono text-2xs uppercase tracking-wider text-[var(--muted-foreground)]">
                {e.agent || "—"}
              </span>
            )}
          </span>
          <span
            className={cn(
              ENTRY_COL.confidence,
              "tabular-nums text-2xs text-[var(--muted-foreground)]",
            )}
          >
            {confidenceLabel(e.confidence)}
          </span>
          <span className={cn(ENTRY_COL.content, "min-w-0 pr-3")}>
            <span className="block truncate text-sm text-[var(--secondary-foreground)]">
              {e.content || <span className="text-[var(--atlas-text-disabled)]">—</span>}
            </span>
          </span>
          <span
            className={cn(
              ENTRY_COL.chevron,
              "flex items-center justify-end text-[var(--muted-foreground)]",
            )}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </button>
      </div>
      {expanded && <EntryDetail entry={e} />}
    </div>
  );
}

/** An expanded entry: its full provenance, its content, and the edit and
 *  forget actions. Editing follows the Policy view: a draft, save, revert. */
function EntryDetail({ entry: e }: { entry: MemoryEntry }) {
  const { editEntry, forgetEntry, purgeEntry } = useSharedMemoryStore.use.actions();
  const projectPath = useSharedMemoryStore.use.projectPath();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(e.content);
  const [saving, setSaving] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  const [provenance, setProvenance] = useState<Provenance[]>([]);

  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    sharedMemory
      .provenance(projectPath, e.id)
      .then((p) => {
        if (alive) setProvenance(p ?? []);
      })
      .catch(() => {
        if (alive) setProvenance([]);
      });
    return () => {
      alive = false;
    };
  }, [projectPath, e.id]);
  const dirty = draft.trim() !== e.content.trim() && draft.trim().length > 0;

  useEffect(() => {
    if (!editing) setDraft(e.content);
  }, [e.content, editing]);

  const cancel = () => {
    setDraft(e.content);
    setEditing(false);
  };

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await editEntry(e.id, draft);
      setEditing(false);
      toast.success("Memory updated");
    } catch (err) {
      toast.error(`Couldn't update: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const forget = async () => {
    setConfirmForget(false);
    try {
      await forgetEntry(e.id);
      toast.success("Memory forgotten");
    } catch (err) {
      toast.error(`Couldn't forget: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const erase = async () => {
    setConfirmErase(false);
    try {
      await purgeEntry(e.id);
      toast.success("Memory erased with its history");
    } catch (err) {
      toast.error(`Couldn't erase: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="bg-[var(--card)]/40 border-t border-[var(--atlas-border-subtle)] px-4 py-3 space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <MetaChip label="Kind" value={KIND_LABEL[e.kind] ?? e.kind.replace(/_/g, " ")} />
        <MetaChip label="Source" value={sourceLabel(e.source)} />
        <MetaChip
          label="Agent"
          value={entryAgent(e.agent) ? agentMetaForSource(e.agent).label : e.agent || "—"}
        />
        <MetaChip label="Confidence" value={confidenceLabel(e.confidence)} />
        {e.key && <MetaChip label="Key" value={e.key} mono />}
        <MetaChip label="Created" value={fmtDateTime(e.createdAt)} />
        <MetaChip label="Updated" value={fmtDateTime(e.updatedAt)} />
        {e.uses > 0 && <MetaChip label="Uses" value={String(e.uses)} />}
        {e.sessionId && <MetaChip label="Session" value={e.sessionId.slice(0, 8)} mono />}
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <IconButton label="Save (⌘Enter)" onClick={() => void save()}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              </IconButton>
              <IconButton label="Cancel (Esc)" onClick={cancel}>
                <X size={12} />
              </IconButton>
            </>
          ) : (
            <>
              <IconButton label="Edit memory" onClick={() => setEditing(true)}>
                <Pencil size={12} />
              </IconButton>
              <IconButton label="Forget memory" onClick={() => setConfirmForget(true)}>
                <Trash2 size={12} />
              </IconButton>
              <IconButton label="Erase with history" onClick={() => setConfirmErase(true)}>
                <Eraser size={12} />
              </IconButton>
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          value={draft}
          autoFocus
          onChange={(ev) => setDraft(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
              ev.preventDefault();
              void save();
            } else if (ev.key === "Escape") {
              cancel();
            }
          }}
          spellCheck={false}
          rows={Math.min(8, Math.max(2, draft.split("\n").length))}
          aria-label="Memory content"
          className={cn(
            "block w-full resize-y rounded-lg border bg-[var(--background)] px-3 py-2 font-sans text-sm leading-[1.55] text-[var(--foreground)] outline-none transition-colors",
            dirty ? "border-[var(--atlas-border-strong)]" : "border-[var(--border)]",
          )}
        />
      ) : (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2">
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-[1.55] text-[var(--secondary-foreground)]">
            {e.content || "—"}
          </pre>
        </div>
      )}
      {provenance.length > 0 && (
        <div className="space-y-0.5">
          {provenance.map((p, i) => (
            <p key={`${p.source}-${i}`} className="text-xs text-[var(--muted-foreground)]">
              {provenanceLine(p)}
            </p>
          ))}
        </div>
      )}
      <FileTreeConfirmDelete
        open={confirmForget}
        name={e.content}
        isDir={false}
        title="Forget this memory?"
        body="Every agent on this project stops seeing it, and it no longer shows in search. This can't be undone."
        confirmLabel="Forget"
        onConfirm={() => void forget()}
        onOpenChange={setConfirmForget}
      />
      <FileTreeConfirmDelete
        open={confirmErase}
        name={e.content}
        isDir={false}
        title="Erase this memory and its history?"
        body="It is forgotten, and every earlier wording is overwritten on disk. Use this for a secret that slipped into memory. This can't be undone. Recorded sessions in the Timeline keep their own copy of the conversation; this does not change them."
        confirmLabel="Erase"
        onConfirm={() => void erase()}
        onOpenChange={setConfirmErase}
      />
    </div>
  );
}

/* ── Import of Claude's auto-memory ──────────────────────────────────────────── */

const NO_PREVIEW: ClaudeImportPreview = { sources: [], alreadyImported: false, lines: [] };

/** Preview, then consent: every line Claude's auto-memory maps to, with its
 *  kind; the new ones start ticked. Only Import writes. Composed from the
 *  Import sessions modal's Dialog shell, tokens and type scale. */
/** The AGENTS.md export: a preview of the file as it would be written, then
 *  Write. Only the managed block changes; nothing is written on Cancel. */
function ExportAgentsModal({
  open,
  ids,
  onOpenChange,
  onWritten,
}: {
  open: boolean;
  ids: number[];
  onOpenChange: (open: boolean) => void;
  onWritten: () => void;
}) {
  const projectPath = useSharedMemoryStore.use.projectPath();
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const key = ids.join(",");

  useEffect(() => {
    if (!open || !projectPath) return;
    let alive = true;
    setPreview(null);
    setError(null);
    sharedMemory
      .exportPreview(projectPath, ids)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // `key` stands for `ids`: a new array each render must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectPath, key]);

  const write = async () => {
    if (!projectPath) return;
    setWriting(true);
    try {
      const path = await sharedMemory.exportApply(projectPath, ids);
      toast.success(`Wrote ${ids.length} ${ids.length === 1 ? "memory" : "memories"} to ${path}`);
      onWritten();
      onOpenChange(false);
    } catch (e) {
      toast.error(`Export failed: ${String(e)}`);
    } finally {
      setWriting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[620px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border bg-card shadow-lg animate-scale-in",
          )}
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <Dialog.Title className="text-base font-semibold text-foreground">
              Export to AGENTS.md
            </Dialog.Title>
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>
          <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
            {preview
              ? `${preview.path}: only the block between the atlas-memory markers changes.`
              : error
                ? error
                : "Preparing the preview…"}
          </p>
          <div className="flex-1 overflow-auto px-4 py-2">
            {preview && (
              <pre className="whitespace-pre-wrap break-words rounded border border-border bg-background p-2 font-mono text-2xs text-secondary-foreground">
                {preview.after}
              </pre>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            <Dialog.Close className="rounded px-2.5 py-1 text-xs text-secondary-foreground hover:bg-element-hover transition-colors cursor-pointer">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              disabled={writing || preview === null}
              onClick={() => void write()}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                "bg-primary text-primary-foreground hover:bg-primary",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {writing ? "Writing…" : "Write"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Import an Agent Memory Repo folder: pick it, see every line it would
 *  write, then Import. Lines land as unconfirmed candidates (Review tab). */
function ImportRepoModal({
  projectPath,
  open,
  onOpenChange,
  onImported,
}: {
  projectPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const [dir, setDir] = useState<string | null>(null);
  const [lines, setLines] = useState<RepoImportLine[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setDir(null);
      setLines(null);
      setSelected(new Set());
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const choose = async () => {
    setError(null);
    try {
      const { open: pick } = await import("@tauri-apps/plugin-dialog");
      const picked = await pick({ directory: true });
      if (typeof picked !== "string") return;
      // The old folder's lines and picks never pair with a new folder.
      setDir(null);
      setLines(null);
      setSelected(new Set());
      const found = await sharedMemory.previewRepoImport(projectPath, picked);
      setDir(picked);
      setLines(found);
      setSelected(new Set(found.filter((l) => l.isNew).map((l) => l.id)));
    } catch (e) {
      setError(String(e));
    }
  };

  const runImport = async () => {
    if (!dir) return;
    setBusy(true);
    try {
      const count = await sharedMemory.confirmRepoImport(projectPath, dir, [...selected]);
      toast.success(`Imported ${count} ${count === 1 ? "line" : "lines"} to review`);
      onImported();
      onOpenChange(false);
    } catch (e) {
      toast.error(`Import failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border bg-card shadow-lg animate-scale-in",
          )}
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <Dialog.Title className="text-base font-semibold text-foreground">
              Import memory repo
            </Dialog.Title>
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>
          <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
            Bring in an Agent Memory Repo (a folder with a MEMORY.md). Lines land as unconfirmed
            candidates: no agent is briefed on them until you approve them in Review.
          </p>
          <div className="flex items-center gap-2 px-4 pt-2 text-xs">
            <button
              type="button"
              onClick={() => void choose()}
              className="h-6 rounded-md border border-border px-2 text-secondary-foreground hover:bg-element-hover"
            >
              Choose folder…
            </button>
            <span className="min-w-0 truncate text-muted-foreground">{dir ?? ""}</span>
          </div>
          <div className="flex-1 overflow-auto px-4 py-2">
            {error ? (
              <div className="text-xs text-muted-foreground">{error}</div>
            ) : lines && lines.length === 0 ? (
              <div className="text-xs text-muted-foreground">No memory lines in that folder.</div>
            ) : (
              lines?.map((l) => (
                <label key={l.id} className="flex items-baseline gap-2 py-1 text-xs">
                  <input
                    type="checkbox"
                    disabled={!l.isNew}
                    checked={selected.has(l.id)}
                    onChange={() => toggle(l.id)}
                  />
                  <span className="w-20 shrink-0 text-2xs text-muted-foreground">{l.kind}</span>
                  <span className={cn("min-w-0 flex-1", !l.isNew && "text-muted-foreground")}>
                    {l.content}
                    {l.meta && (
                      <span className="block text-2xs text-muted-foreground">{l.meta}</span>
                    )}
                  </span>
                </label>
              ))
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            <Dialog.Close className="rounded px-2.5 py-1 text-xs text-secondary-foreground hover:bg-element-hover transition-colors cursor-pointer">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={() => void runImport()}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                "bg-primary text-primary-foreground hover:bg-primary",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {busy ? "Importing…" : selected.size > 0 ? `Import ${selected.size}` : "Import"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ImportClaudeMemoryModal({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const { previewClaudeImport, importClaude } = useSharedMemoryStore.use.actions();
  const [preview, setPreview] = useState<ClaudeImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) {
      setPreview(null);
      setSelected(new Set());
      return;
    }
    let cancelled = false;
    void previewClaudeImport()
      .then((found) => {
        if (cancelled) return;
        const p = found ?? NO_PREVIEW;
        setPreview(p);
        setSelected(new Set(p.lines.filter((l) => l.isNew).map((l) => l.id)));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreview(NO_PREVIEW);
        toast.error(`Couldn't read Claude's memory: ${String(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open, previewClaudeImport]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const runImport = async () => {
    setImporting(true);
    try {
      const count = await importClaude([...selected]);
      toast.success(
        count === 0
          ? "Nothing new to import"
          : `Imported ${count} ${count === 1 ? "memory" : "memories"} from Claude`,
      );
      onOpenChange(false);
      onImported();
    } catch (err) {
      toast.error(`Import failed: ${String(err)}`);
    } finally {
      setImporting(false);
    }
  };

  const fresh = preview?.lines.filter((l) => l.isNew).length ?? 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <DialogOverlay blur />
        <Dialog.Popup
          aria-describedby={undefined}
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[80vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-md",
            "border border-border bg-card shadow-lg animate-scale-in",
          )}
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
            <Dialog.Title className="text-base font-semibold text-foreground">
              Import Claude memory
            </Dialog.Title>
            <Dialog.Close
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-element-hover hover:text-foreground transition-colors"
              aria-label="Close"
            >
              <X size={13} />
            </Dialog.Close>
          </div>

          <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
            {preview?.alreadyImported
              ? "Already imported: Claude's memory for this project was brought in before, so there is nothing new to import."
              : "Bring the memories Claude Code kept for this project into shared memory, so every agent sees them. Imported lines are marked as from Claude, at 70% confidence."}
          </p>

          <div className="flex-1 overflow-auto hide-scrollbar px-2 py-2">
            {preview === null ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                Reading Claude's memory…
              </div>
            ) : preview.lines.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                Claude has no memory for this project.
              </div>
            ) : (
              preview.lines.map((line) => (
                <ImportLineRow
                  key={line.id}
                  line={line}
                  checked={selected.has(line.id)}
                  onToggle={() => toggle(line.id)}
                />
              ))
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
            <Dialog.Close className="rounded px-2.5 py-1 text-xs text-secondary-foreground hover:bg-element-hover transition-colors cursor-pointer">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              disabled={importing || fresh === 0 || selected.size === 0}
              onClick={() => void runImport()}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer",
                "bg-primary text-primary-foreground hover:bg-primary",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              {importing ? "Importing…" : selected.size > 0 ? `Import ${selected.size}` : "Import"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ImportLineRow({
  line,
  checked,
  onToggle,
}: {
  line: ClaudeImportLine;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      disabled={!line.isNew}
      onClick={onToggle}
      title={line.file}
      className={cn(
        "flex items-center gap-1.5 w-full rounded px-2 py-1.5 text-left transition-colors",
        !line.isNew && "cursor-not-allowed opacity-60",
        line.isNew && (checked ? "bg-element-selected" : "cursor-pointer hover:bg-element-hover"),
      )}
    >
      <span className="w-[64px] shrink-0">
        <KindChip kind={line.kind} />
      </span>
      <span className="flex-1 min-w-0 truncate text-xs text-foreground">{line.content}</span>
      {!line.isNew && (
        <span className="shrink-0 text-2xs text-muted-foreground">already in memory</span>
      )}
      {checked && <Check size={12} className="text-secondary-foreground shrink-0" />}
    </button>
  );
}

/* ── Primitives ──────────────────────────────────────────────────────────────── */

function HeaderRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex items-center h-[28px] border-b border-[var(--border)] bg-[var(--background)] px-3 text-2xs uppercase tracking-wider text-[var(--muted-foreground)]">
      {children}
    </div>
  );
}

function EmptyRows({ label }: { label: string }) {
  return (
    <div className="grid place-items-center h-[160px] text-xs text-[var(--muted-foreground)]">
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
function AgentTag({ agent }: { agent: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 min-w-0">
      <AgentMark agentType={pluginIdForSource(agent)} />
      <span className="truncate font-mono text-2xs uppercase tracking-wider text-[var(--muted-foreground)]">
        {agentMetaForSource(agent).label}
      </span>
    </span>
  );
}

const KIND_LABEL: Record<string, string> = {
  plan_set: "plan",
  plan: "plan",
  decision: "decision",
  file_changed: "file",
  fact: "fact",
  session_start: "session start",
  session_end: "session end",
  todo_added: "todo +",
  todo_done: "todo ✓",
};

/** The table's small label chip (kind, source). */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-center rounded bg-[var(--card)] px-1.5 py-0.5 text-2xs text-[var(--muted-foreground)]">
      <span className="truncate">{children}</span>
    </span>
  );
}

/** "Learned in “title” · agent · date → sha", or the bare source. */
export function provenanceLine(p: Provenance): string {
  const date = p.added ?? "";
  if (p.title) {
    const commit = p.commits[0] ? ` → ${p.commits[0].slice(0, 7)}` : "";
    return `Learned in “${p.title}” · ${p.agent} · ${date}${commit}`;
  }
  if (p.source === "atlas-user") return `Written by you · ${date}`;
  return `From ${p.source} · ${date}`;
}

/** A candidate or archived entry's state, beside its source. */
function StateChip({ state }: { state: string }) {
  return (
    <span className="text-3xs uppercase tracking-wide text-[var(--muted-foreground)] border border-[var(--border)] rounded px-1 py-px">
      {state}
    </span>
  );
}

function KindChip({ kind }: { kind: string }) {
  return <Chip>{KIND_LABEL[kind] ?? kind.replace(/_/g, " ")}</Chip>;
}

/** An entry's source, in the same chip as its kind. */
function SourceChip({ source }: { source: string }) {
  return <Chip>{sourceLabel(source)}</Chip>;
}

function StatusChip({ status }: { status: string }) {
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

function MetaChip({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
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

function EmptyState() {
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
