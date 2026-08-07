import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Download,
  Sparkles,
  Search,
  X,
  AlertTriangle,
  RotateCw,
  Play,
  Pause,
  Clock,
  Network,
  ListTree,
  ArrowUpRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useMemoryGraphStore } from "../stores/memory-graph-store";
import { useMemoryStore } from "../stores/memory-store";
import { MemoryGraphCanvas } from "./memory-graph-canvas";
import { MemoryTreeView } from "./memory-tree-view";

type ViewMode = "graph" | "tree";
const VIEW_KEY = "atlas-memory-graph-view-mode";

const MODEL_LABEL = "all-MiniLM-L6-v2 · ~90 MB";

export function MemoryGraphView() {
  const projectPath = useProjectStore.use.currentProject()?.path ?? null;
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

  if (!projectPath) {
    return <Centered>Open a project first.</Centered>;
  }

  if (phase === "checking") {
    return (
      <Centered>
        <Loader2 size={18} className="animate-spin text-[var(--text-tertiary)]" />
      </Centered>
    );
  }

  if (phase === "not-downloaded") {
    return (
      <Centered>
        <div className="text-center max-w-[360px] px-6 space-y-3">
          <div className="w-12 h-12 mx-auto rounded-xl bg-[var(--bg-elevated)] border border-[var(--border-default)] flex items-center justify-center">
            <Sparkles size={22} className="text-[var(--text-secondary)]" />
          </div>
          <div className="space-y-1">
            <h3 className="text-[13px] font-medium text-[var(--text-primary)]">
              Enable semantic memory
            </h3>
            <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]">
              Download a small on-device embedding model to index your Claude & Codex memory, map
              how it relates, and query it in natural language. Runs entirely locally — nothing
              leaves your machine.
            </p>
          </div>
          <button
            onClick={() => void download()}
            className="inline-flex items-center gap-1.5 h-8 px-3.5 rounded-md bg-[var(--accent-primary)] text-[var(--bg-base)] text-[11px] font-medium hover:opacity-90 transition-opacity cursor-pointer"
          >
            <Download size={13} />
            Download model
          </button>
          <p className="text-[10px] text-[var(--text-ghost)] font-mono">{MODEL_LABEL}</p>
        </div>
      </Centered>
    );
  }

  if (phase === "downloading") {
    const pct = progress
      ? Math.round(
          ((progress.file_index + (progress.total ? progress.received / progress.total : 0)) /
            Math.max(1, progress.file_count)) *
            100,
        )
      : 0;
    return (
      <Centered>
        <div className="text-center max-w-[360px] px-6 w-full space-y-3">
          <Loader2 size={20} className="animate-spin text-[var(--text-secondary)] mx-auto" />
          <div className="space-y-1.5">
            <p className="text-[12px] text-[var(--text-primary)]">Downloading model…</p>
            <div className="h-1.5 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
              <div
                className="h-full bg-[var(--accent-primary)] transition-[width] duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-[10px] text-[var(--text-tertiary)] font-mono">
              {progress
                ? `${progress.file}  ·  ${fmtMB(progress.received)} / ${fmtMB(progress.total)}  ·  ${pct}%`
                : "starting…"}
            </p>
          </div>
        </div>
      </Centered>
    );
  }

  if (phase === "download-failed" || phase === "error") {
    return (
      <Centered>
        <div className="text-center max-w-[340px] px-6 space-y-3">
          <AlertTriangle size={20} className="text-[var(--status-error)] mx-auto" />
          <p className="text-[12px] text-[var(--text-secondary)]">
            {phase === "download-failed" ? "Model download failed" : "Something went wrong"}
          </p>
          {error && (
            <p className="text-[10px] text-[var(--text-tertiary)] font-mono break-words">{error}</p>
          )}
          <button
            onClick={() => (phase === "download-failed" ? void download() : void init(projectPath))}
            className="inline-flex items-center gap-1.5 h-7 px-3 rounded-md border border-[var(--border-default)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            <RotateCw size={12} />
            Retry
          </button>
        </div>
      </Centered>
    );
  }

  if (phase === "indexing") {
    return (
      <Centered>
        <div className="text-center space-y-2">
          <Loader2 size={18} className="animate-spin text-[var(--text-secondary)] mx-auto" />
          <p className="text-[11px] text-[var(--text-tertiary)]">Indexing memory…</p>
        </div>
      </Centered>
    );
  }

  // phase === "graph-ready"
  if (!graph || graph.nodes.length === 0) {
    return (
      <Centered>
        <p className="text-[12px] text-[var(--text-tertiary)]">No memory to graph yet.</p>
      </Centered>
    );
  }

  return (
    <GraphReady
      projectPath={projectPath}
      graph={graph}
      docCount={docCount}
      query={query}
      querying={querying}
      results={results}
      matchedIds={matchedIds}
      selectedId={selectedId}
      onQueryChange={setQuery}
      onRunQuery={(q) => void runQuery(projectPath, q)}
      onClearQuery={clearQuery}
      onSelect={select}
      onReindex={() => void buildIndex(projectPath)}
    />
  );
}

function GraphReady({
  projectPath,
  graph,
  docCount,
  query,
  querying,
  results,
  matchedIds,
  selectedId,
  onQueryChange,
  onRunQuery,
  onClearQuery,
  onSelect,
  onReindex,
}: {
  projectPath: string;
  graph: import("./memory-graph-canvas").MemoryGraphData;
  docCount: number;
  query: string;
  querying: boolean;
  results: { id: string; score: number }[];
  matchedIds: Set<string>;
  selectedId: string | null;
  onQueryChange: (q: string) => void;
  onRunQuery: (q: string) => void;
  onClearQuery: () => void;
  onSelect: (id: string | null) => void;
  onReindex: () => void;
}) {
  const nodeById = useMemo(() => {
    const m = new Map<string, (typeof graph.nodes)[number]>();
    for (const n of graph.nodes) m.set(n.id, n);
    return m;
  }, [graph.nodes]);

  const selected = selectedId ? nodeById.get(selectedId) : undefined;

  // Time bounds for the scrubber.
  const { minTs, maxTs } = useMemo(() => {
    let mn = Infinity;
    let mx = 0;
    for (const node of graph.nodes) {
      if (node.timestampMs > 0) {
        mn = Math.min(mn, node.timestampMs);
        mx = Math.max(mx, node.timestampMs);
      }
    }
    return { minTs: Number.isFinite(mn) ? mn : 0, maxTs: mx };
  }, [graph.nodes]);
  const hasTime = maxTs > minTs;

  const [cutoff, setCutoff] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const rafRef = useRef<number | undefined>(undefined);

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null;
    // Tree is the default/initial view; only an explicit "graph" pref overrides.
    return v === "graph" ? "graph" : "tree";
  });
  const setView = (m: ViewMode) => {
    setViewMode(m);
    try {
      localStorage.setItem(VIEW_KEY, m);
    } catch {
      /* ignore */
    }
  };

  const { navigateToMemory } = useMemoryStore.use.actions();

  // Esc deselects the active node (unless typing in the search field).
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      onSelect(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, onSelect]);

  // Jump from the detail card to the source memory: Claude file, Codex thread,
  // native Atlas (cersei) session, or a capture-backed agent session view
  // (opencode/cursor/kilo). Anything else (codebase/shared/note) → Claude tab.
  const openSource = () => {
    if (!selected) return;
    const sub =
      selected.source === "codex" ||
      selected.source === "cersei" ||
      selected.source === "opencode" ||
      selected.source === "cursor" ||
      selected.source === "kilo"
        ? selected.source
        : "claude";
    navigateToMemory(sub, selected.id);
  };

  // Animate the cutoff from oldest → newest, then reveal everything.
  useEffect(() => {
    if (!playing || !hasTime) return;
    let startT = 0;
    const DURATION = 9000;
    const step = (t: number) => {
      if (!startT) startT = t;
      const frac = Math.min(1, (t - startT) / DURATION);
      setCutoff(minTs + frac * (maxTs - minTs));
      if (frac < 1) rafRef.current = requestAnimationFrame(step);
      else {
        setPlaying(false);
        setCutoff(null);
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, hasTime, minTs, maxTs]);

  return (
    <div className="h-full flex flex-col bg-[var(--bg-base)]">
      {/* Query bar */}
      <div className="flex items-center gap-2 px-3 h-[32px] shrink-0 border-b border-[var(--border-default)]">
        {/* Tree / Graph toggle — top-left. Tree (the decision tree) is the
            primary view, so it sits first. */}
        <div className="flex items-center gap-0.5 h-6 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] p-0.5 shrink-0">
          <button
            onClick={() => setView("tree")}
            title="Decision tree"
            className={cn(
              "flex items-center gap-1 px-1.5 h-5 rounded-[5px] text-[10px] font-medium transition-colors cursor-pointer",
              viewMode === "tree"
                ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
            )}
          >
            <ListTree size={11} /> Tree
          </button>
          <button
            onClick={() => setView("graph")}
            title="Force graph"
            className={cn(
              "flex items-center gap-1 px-1.5 h-5 rounded-[5px] text-[10px] font-medium transition-colors cursor-pointer",
              viewMode === "graph"
                ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                : "text-[var(--text-tertiary)] hover:text-[var(--text-primary)]",
            )}
          >
            <Network size={11} /> Graph
          </button>
        </div>
        <div className="flex items-center gap-1.5 h-6 flex-1 max-w-[440px] rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 focus-within:border-[var(--border-strong)]">
          <Search size={12} className="text-[var(--text-tertiary)] shrink-0" />
          <input
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRunQuery(query);
              else if (e.key === "Escape") onClearQuery();
            }}
            placeholder="Ask your memory… (Enter to search)"
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent outline-none text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
          />
          {querying && <Loader2 size={11} className="animate-spin text-[var(--text-tertiary)]" />}
          {query && !querying && (
            <button
              onClick={onClearQuery}
              className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums">
          {docCount} memories · {graph.edges.length} links
        </span>
        <button
          onClick={onReindex}
          className="flex items-center justify-center w-6 h-6 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
          title="Re-index memory"
        >
          <RotateCw size={12} />
        </button>
      </div>

      {/* Canvas + optional results rail */}
      <div className="flex-1 min-h-0 flex">
        <div className="relative flex-1 min-w-0">
          {viewMode === "graph" ? (
            <MemoryGraphCanvas
              graph={graph}
              projectPath={projectPath}
              selectedId={selectedId}
              matchedIds={matchedIds}
              cutoffMs={cutoff}
              onSelect={onSelect}
              onActivate={onSelect}
            />
          ) : (
            <MemoryTreeView
              graph={graph}
              projectPath={projectPath}
              selectedId={selectedId}
              matchedIds={matchedIds}
              cutoffMs={cutoff}
              onSelect={onSelect}
              onActivate={onSelect}
            />
          )}

          {/* Time scrubber — watch memory accrue; drag to a moment in time. */}
          {hasTime && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-2 rounded-full border border-[var(--border-default)] bg-[var(--bg-elevated)]/90 backdrop-blur-sm px-2.5 h-9 shadow-[var(--shadow-overlay)]">
              <button
                onClick={() => setPlaying((p) => !p)}
                className="flex items-center justify-center w-6 h-6 rounded-full text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)] transition-colors cursor-pointer"
                title={playing ? "Pause" : "Play timeline"}
              >
                {playing ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <Clock size={11} className="text-[var(--text-tertiary)]" />
              <input
                type="range"
                min={minTs}
                max={maxTs}
                step={Math.max(1, Math.round((maxTs - minTs) / 500))}
                value={cutoff ?? maxTs}
                onChange={(e) => {
                  setPlaying(false);
                  const v = Number(e.target.value);
                  setCutoff(v >= maxTs ? null : v);
                }}
                className="w-[220px] h-1 accent-[var(--accent-primary)] cursor-pointer"
              />
              <span className="text-[10px] tabular-nums text-[var(--text-tertiary)] w-[78px] text-right">
                {cutoff ? fmtDate(cutoff) : "All time"}
              </span>
            </div>
          )}

          {/* Impact-mode legend (graph only, while a node is selected). */}
          {selected && viewMode === "graph" && (
            <div className="absolute right-3 top-[26px] flex items-center gap-3 rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)]/90 backdrop-blur-sm px-2.5 h-7 text-[10px] text-[var(--text-tertiary)]">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: "#fafafa" }} /> impacted
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: "#6796e6" }} />{" "}
                influenced by
              </span>
            </div>
          )}
          {/* Selected node detail card — click to open the source memory. */}
          {selected && (
            <button
              onClick={openSource}
              title={
                selected.source === "codex" ||
                selected.source === "cersei" ||
                selected.source === "opencode" ||
                selected.source === "cursor" ||
                selected.source === "kilo"
                  ? "Open this session in its agent tab"
                  : "Open this file in the Claude Code tab"
              }
              className="group absolute left-[26px] bottom-3 max-w-[340px] text-left rounded-lg border border-[var(--border-default)] hover:border-[var(--border-strong)] bg-[var(--bg-elevated)]/90 backdrop-blur-sm shadow-[var(--shadow-overlay)] p-3 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-1.5 mb-1">
                <SourceDot source={selected.source} />
                <span className="text-[11px] font-medium text-[var(--text-primary)] truncate">
                  {selected.summary || selected.title}
                </span>
                <ArrowUpRight
                  size={12}
                  className="ml-auto shrink-0 text-[var(--text-tertiary)] opacity-0 group-hover:opacity-100 transition-opacity"
                />
              </div>
              <p className="text-[10px] text-[var(--text-tertiary)] line-clamp-4 leading-relaxed">
                {selected.snippet || "—"}
              </p>
              <p className="text-[9px] text-[var(--text-ghost)] mt-1.5 uppercase tracking-wide">
                {selected.source} · {selected.kind}
                {selected.timestampMs > 0 && ` · ${fmtDate(selected.timestampMs)}`}
              </p>
            </button>
          )}
        </div>

        {results.length > 0 && (
          <aside className="w-[280px] shrink-0 border-l border-[var(--border-default)] overflow-y-auto hide-scrollbar bg-[var(--bg-sidebar)]">
            <div className="px-3 h-[28px] flex items-center text-[9px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)] border-b border-[var(--border-subtle)] sticky top-0 bg-[var(--bg-sidebar)]">
              Results
            </div>
            {results.map((hit) => {
              const node = nodeById.get(hit.id);
              if (!node) return null;
              const active = selectedId === hit.id;
              return (
                <button
                  key={hit.id}
                  onClick={() => onSelect(active ? null : hit.id)}
                  className={cn(
                    "w-full text-left px-3 py-2 border-b border-[var(--border-subtle)] transition-colors flex flex-col gap-0.5",
                    active ? "bg-[var(--bg-selected)]" : "hover:bg-[var(--bg-hover)]",
                  )}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <SourceDot source={node.source} />
                    <span className="text-[11px] text-[var(--text-primary)] truncate flex-1">
                      {node.title}
                    </span>
                    <span className="text-[9px] text-[var(--text-tertiary)] tabular-nums">
                      {Math.round(hit.score * 100)}%
                    </span>
                  </div>
                  <span className="text-[10px] text-[var(--text-tertiary)] line-clamp-2 leading-snug">
                    {node.snippet}
                  </span>
                </button>
              );
            })}
          </aside>
        )}
      </div>
    </div>
  );
}

function SourceDot({ source }: { source: string }) {
  const color =
    source === "codex"
      ? "var(--status-info)"
      : source === "opencode"
        ? "var(--agent-opencode-chip)"
        : source === "cursor"
          ? "var(--agent-cursor-chip)"
          : source === "kilo"
            ? "var(--agent-kilo-chip)"
            : "var(--accent-primary)";
  return <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-[var(--text-tertiary)] text-[12px]">
      {children}
    </div>
  );
}

function fmtMB(bytes: number): string {
  if (!bytes) return "0 MB";
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
