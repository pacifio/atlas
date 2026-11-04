import { useEffect, useState } from "react";
import { useAppStore } from "@/features/app/stores/app-store";
import { useMemoryGraphStore } from "../stores/memory-graph-store";
import { MemoryGraphCanvas } from "./memory-graph-canvas";
import { MemoryTreeView } from "./memory-tree-view";
import { MemoryGraphView, type MemoryGraphViewMode } from "./views/memory-graph-view";

const VIEW_KEY = "atlas-memory-graph-view-mode";

/** The Memory tab's Graph sub-tab: store wiring for `MemoryGraphView`. */
export function MemoryGraph() {
  const projectPath = useAppStore.use.currentProject()?.path ?? null;
  const phase = useMemoryGraphStore.use.phase();
  const progress = useMemoryGraphStore.use.progress();
  const error = useMemoryGraphStore.use.error();
  const graph = useMemoryGraphStore.use.graph();
  const docCount = useMemoryGraphStore.use.docCount();
  const query = useMemoryGraphStore.use.query();
  const querying = useMemoryGraphStore.use.querying();
  const results = useMemoryGraphStore.use.results();
  const matchedIds = useMemoryGraphStore.use.matchedIds();
  const selectedId = useMemoryGraphStore.use.selectedId();
  const { init, download, buildIndex, runQuery, setQuery, clearQuery, select } =
    useMemoryGraphStore.use.actions();

  useEffect(() => {
    if (projectPath) void init(projectPath);
  }, [projectPath, init]);

  const [viewMode, setViewMode] = useState<MemoryGraphViewMode>(() => {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null;
    // Tree is the default/initial view; only an explicit "graph" pref overrides.
    return v === "graph" ? "graph" : "tree";
  });
  const changeViewMode = (m: MemoryGraphViewMode) => {
    setViewMode(m);
    try {
      localStorage.setItem(VIEW_KEY, m);
    } catch {
      /* ignore */
    }
  };

  return (
    <MemoryGraphView
      projectOpen={projectPath !== null}
      phase={phase}
      progress={progress}
      error={error}
      graph={graph}
      docCount={docCount}
      query={query}
      querying={querying}
      results={results}
      selectedId={selectedId}
      viewMode={viewMode}
      onViewModeChange={changeViewMode}
      onDownload={() => void download()}
      onRetry={() => {
        if (phase === "download-failed") void download();
        else if (projectPath) void init(projectPath);
      }}
      onQueryChange={setQuery}
      onRunQuery={(q) => {
        if (projectPath) void runQuery(projectPath, q);
      }}
      onClearQuery={clearQuery}
      onSelect={select}
      onReindex={() => {
        if (projectPath) void buildIndex(projectPath);
      }}
      renderStage={(cutoffMs) => {
        if (!graph || !projectPath) return null;
        const Stage = viewMode === "graph" ? MemoryGraphCanvas : MemoryTreeView;
        return (
          <Stage
            graph={graph}
            projectPath={projectPath}
            selectedId={selectedId}
            matchedIds={matchedIds}
            cutoffMs={cutoffMs}
            onSelect={select}
            onActivate={select}
          />
        );
      }}
    />
  );
}
