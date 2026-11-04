// Container for the Memories tab: search, scope and agent filters, the
// chosen memory, the export pick, and the "Memory updated" card's hand-off
// (open this entry). The markup is `./views/memory-entries-view.tsx`; the
// pane is either `MemoryEntryDetail` or the overview.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSharedMemoryStore } from "../stores/shared-memory-store";
import { useMemoryStore } from "../stores/memory-store";
import { useMemorySharingStore } from "../stores/memory-sharing-store";
import { agentMetaForSource } from "../lib/memory-agent";
import {
  entryMatches,
  groupEntries,
  inScope,
  memorySummary,
  mostUsed,
  type EntryScope,
} from "../lib/memory-entries";
import { reviewCount } from "../lib/memory-review-items";
import { entryAgent, exportable } from "../lib/shared-memory-format";
import { ExportAgentsModal } from "./shared-memory-modals";
import { MemoryEntryDetail } from "./memory-entry-detail";
import { MemoryEntriesView } from "./views/memory-entries-view";
import { MemoryOverviewView } from "./views/memory-overview-view";

export function MemoryEntries({
  projectName,
  selecting,
  onSelectingChange,
  onImportClaude,
}: {
  projectName: string;
  /** Export mode, started from the panel's menu. */
  selecting: boolean;
  onSelectingChange: (on: boolean) => void;
  onImportClaude: () => void;
}) {
  const entries = useSharedMemoryStore.use.entries();
  const loaded = useSharedMemoryStore.use.loaded();
  const error = useSharedMemoryStore.use.error();
  const review = useSharedMemoryStore.use.review();
  const projectPath = useSharedMemoryStore.use.projectPath();
  const { load } = useSharedMemoryStore.use.actions();
  const sharingEnabled = useMemorySharingStore.use.enabled();
  const { setSubTab, clearFocusEntry } = useMemoryStore.use.actions();
  const focusEntryId = useMemoryStore.use.focusEntryId();

  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<EntryScope>("current");
  const [agentFilter, setAgentFilter] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // Asked to open an entry (the "Memory updated" card): show it unfiltered,
  // in whichever scope holds it, then consume the ask.
  useEffect(() => {
    if (focusEntryId == null) return;
    const target = entries.find((e) => e.id === focusEntryId);
    // Not there yet (the record is still being read): wait for it.
    if (!target) return;
    setQuery("");
    setAgentFilter("");
    setScope(target.state === "archived" ? "archived" : "current");
    setSelectedId(target.id);
    clearFocusEntry();
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector(`[data-entry-id="${target.id}"]`)
        ?.scrollIntoView({ block: "center" }),
    );
  }, [focusEntryId, entries, clearFocusEntry]);

  const q = query.trim().toLowerCase();
  const scoped = useMemo(() => entries.filter((e) => inScope(e, scope)), [entries, scope]);
  const groups = useMemo(
    () =>
      groupEntries(
        scoped.filter((e) => (!agentFilter || e.agent === agentFilter) && entryMatches(e, q)),
      ),
    [scoped, agentFilter, q],
  );
  const agentOptions = useMemo(
    () => [...new Set(scoped.map((e) => e.agent).filter((a) => entryAgent(a)))].sort(),
    [scoped],
  );
  const summary = useMemo(() => memorySummary(entries), [entries]);
  const leanedOn = useMemo(() => mostUsed(entries), [entries]);

  const selected = entries.find((e) => e.id === selectedId) ?? null;
  // A chosen memory that was forgotten elsewhere leaves the pane.
  useEffect(() => {
    if (selectedId !== null && loaded && !entries.some((e) => e.id === selectedId)) {
      setSelectedId(null);
    }
  }, [entries, selectedId, loaded]);

  // In the order picked; a row filtered out of view, or no longer
  // exportable, is not exported.
  const visible = new Set(groups.flatMap((g) => g.entries.map((e) => e.id)));
  const chosen = [...picked].filter(
    (id) => visible.has(id) && entries.some((e) => e.id === id && exportable(e)),
  );

  const stopSelecting = () => {
    onSelectingChange(false);
    setPicked(new Set());
  };

  return (
    <MemoryEntriesView
      loaded={loaded}
      error={error}
      onRetry={() => {
        if (projectPath) void load(projectPath);
      }}
      total={{ current: summary.current, archived: summary.archived }}
      groups={groups}
      scope={scope}
      onScopeChange={(s) => {
        setScope(s);
        setSelectedId(null);
        // The other scope may not offer this agent, which would hide the
        // filter while it still applies.
        setAgentFilter("");
      }}
      query={query}
      onQueryChange={setQuery}
      agentFilter={agentFilter}
      agentOptions={agentOptions}
      formatAgent={(a) => agentMetaForSource(a).label}
      onAgentFilterChange={setAgentFilter}
      selectedId={selected ? selected.id : null}
      onSelect={setSelectedId}
      selecting={selecting}
      picked={picked}
      pickedCount={chosen.length}
      onPick={(id) =>
        setPicked((s) => {
          const next = new Set(s);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })
      }
      onExport={() => setExporting(true)}
      onCancelSelecting={stopSelecting}
      onImportClaude={onImportClaude}
      listRef={listRef}
      dialogs={
        <ExportAgentsModal
          open={exporting}
          ids={chosen}
          onOpenChange={setExporting}
          onWritten={stopSelecting}
        />
      }
      pane={
        selected ? (
          <MemoryEntryDetail
            key={selected.id}
            entry={selected}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <MemoryOverviewView
            projectName={projectName}
            current={summary.current}
            unconfirmed={summary.unconfirmed}
            agents={summary.agents}
            newest={summary.newest}
            reviewCount={reviewCount(review)}
            onOpenReview={() => setSubTab("review")}
            mostUsed={leanedOn}
            onSelect={setSelectedId}
            sharingEnabled={sharingEnabled}
          />
        )
      }
    />
  );
}
