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
//
// Despite the name this is the container: store, filters and dialogs state.
// The markup is under `./views/`; the Memories table and the dialogs have
// their own containers (`shared-memory-entries.tsx`, `shared-memory-modals.tsx`).

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PanelSkeleton } from "@/components/panel-skeleton";
import { FileTreeConfirmDelete } from "@/features/explorer/components/file-tree-confirm-delete";
import { cn } from "@/lib/utils";
import { MemoryReviewView } from "./memory-review-view";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { useMemoryStore } from "../stores/memory-store";
import type { MemoryEvent } from "../lib/shared-memory-api";
import { eventDetail, sourceLabel } from "../lib/shared-memory-format";
import { EmptyState } from "./views/shared-memory-primitives";
import { EventsTable, PlansTable } from "./views/shared-memory-event-tables";
import { SharedMemoryToolbar, type SharedMemoryTab } from "./views/shared-memory-toolbar";
import { MemoriesTable } from "./shared-memory-entries";
import { ImportClaudeMemoryModal, ImportRepoModal } from "./shared-memory-modals";

export { confidenceLabel, provenanceLine, sourceLabel } from "../lib/shared-memory-format";

interface Props {
  projectPath: string;
  className?: string;
}

type Tab = SharedMemoryTab;

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
      <SharedMemoryToolbar
        tab={tab}
        onTabChange={setTab}
        eventCount={events.length}
        planCount={plans.length}
        entryCount={entries.length}
        agentFilter={agentFilter}
        agentOptions={agentOptions}
        onAgentFilterChange={setAgentFilter}
        kindFilter={kindFilter}
        kindOptions={kindOptions}
        onKindFilterChange={setKindFilter}
        query={query}
        onQueryChange={setQuery}
        onRefresh={() => void refresh()}
        onImportClaude={() => setImporting(true)}
        onImportRepo={() => setImportingRepo(true)}
        onClear={() => setConfirmClear(true)}
      />
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
