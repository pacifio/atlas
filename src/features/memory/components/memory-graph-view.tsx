import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  Download,
  Sparkles,
  X,
  AlertTriangle,
  RotateCw,
  Play,
  Pause,
  Clock,
  Network,
  ListTree,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { Button } from "@/ui/button";
import { IconButton } from "@/ui/icon-button";
import { useAppStore } from "@/features/app/stores/app-store";
import { agentBrandColor } from "@/features/agents/lib/agent-brand";
import { useMemoryGraphStore } from "../stores/memory-graph-store";
import { MemoryGraphCanvas } from "./memory-graph-canvas";
import { MemoryTreeView } from "./memory-tree-view";
import {
  Notice,
  ProgressBar,
  SearchField,
  Toolbar,
  Track,
  TrackSegment,
} from "./views/memory-chrome";

type ViewMode = "graph" | "tree";
const VIEW_KEY = "atlas-memory-graph-view-mode";

const MODEL_LABEL = "all-MiniLM-L6-v2 · ~90 MB";

export function MemoryGraphView() {
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

  if (!projectPath) {
    return <Notice>Open a project first.</Notice>;
  }

  if (phase === "checking") {
    return <Notice icon={<Loader2 size={18} className="animate-spin" />} />;
  }

  if (phase === "not-downloaded") {
    return (
      <Notice
        icon={<Sparkles size={20} />}
        title="Enable semantic memory"
        action={
          <Button size="lg" onClick={() => void download()}>
            <Download size={13} />
            Download model
          </Button>
        }
        footnote={<span className="font-mono">{MODEL_LABEL}</span>}
      >
        Download a small on-device embedding model to index your Claude & Codex memory, map how it
        relates, and query it in natural language. Runs entirely locally — nothing leaves your
        machine.
      </Notice>
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
      <Notice icon={<Loader2 size={18} className="animate-spin" />} title="Downloading model…">
        <div className="flex w-[320px] max-w-full flex-col gap-2 pt-1">
          <ProgressBar pct={pct} />
          <p className="font-mono text-2xs tabular-nums">
            {progress
              ? `${progress.file}  ·  ${fmtMB(progress.received)} / ${fmtMB(progress.total)}  ·  ${pct}%`
              : "starting…"}
          </p>
        </div>
      </Notice>
    );
  }

  if (phase === "download-failed" || phase === "error") {
    return (
      <Notice
        icon={<AlertTriangle size={18} className="text-error" />}
        title={phase === "download-failed" ? "Model download failed" : "Something went wrong"}
        action={
          <Button
            variant="outline"
            onClick={() => (phase === "download-failed" ? void download() : void init(projectPath))}
          >
            <RotateCw size={12} />
            Retry
          </Button>
        }
      >
        {error && <p className="font-mono text-2xs break-words">{error}</p>}
      </Notice>
    );
  }

  if (phase === "indexing") {
    return <Notice icon={<Loader2 size={18} className="animate-spin" />}>Indexing memory…</Notice>;
  }

  // phase === "graph-ready"
  if (!graph || graph.nodes.length === 0) {
    return <Notice>No memory to graph yet.</Notice>;
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
    <div className="flex h-full flex-col bg-background">
      {/* Query bar */}
      <Toolbar>
        {/* Tree / Graph toggle — top-left. Tree (the decision tree) is the
            primary view, so it sits first. */}
        <Track>
          <TrackSegment
            active={viewMode === "tree"}
            onClick={() => setView("tree")}
            title="Decision tree"
          >
            <ListTree size={11} /> Tree
          </TrackSegment>
          <TrackSegment
            active={viewMode === "graph"}
            onClick={() => setView("graph")}
            title="Force graph"
          >
            <Network size={11} /> Graph
          </TrackSegment>
        </Track>
        <SearchField
          value={query}
          onChange={onQueryChange}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRunQuery(query);
            else if (e.key === "Escape") onClearQuery();
          }}
          placeholder="Ask your memory… (Enter to search)"
          className="max-w-[440px] flex-1"
          trailing={
            <>
              {querying && <Loader2 size={11} className="animate-spin text-muted-foreground" />}
              {query && !querying && (
                <Hint label="Clear search">
                  <button
                    type="button"
                    onClick={onClearQuery}
                    className="cursor-pointer text-muted-foreground transition-colors duration-fast hover:text-foreground"
                  >
                    <X size={12} />
                  </button>
                </Hint>
              )}
            </>
          }
        />
        <div className="flex-1" />
        <span className="caption tabular-nums">
          {docCount} memories · {graph.edges.length} links
        </span>
        <Hint label="Re-index memory">
          <IconButton icon={RotateCw} label="Re-index memory" size="sm" onClick={onReindex} />
        </Hint>
      </Toolbar>

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
            <div
              className={cn(
                "absolute bottom-3 left-1/2 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full px-2",
                HUD,
              )}
            >
              <Hint label={playing ? "Pause" : "Play timeline"} side="top">
                <IconButton
                  icon={playing ? Pause : Play}
                  label={playing ? "Pause" : "Play timeline"}
                  size="sm"
                  shape="round"
                  onClick={() => setPlaying((p) => !p)}
                />
              </Hint>
              <Clock size={11} className="text-muted-foreground" />
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
                className="h-1 w-[220px] cursor-pointer accent-foreground"
              />
              <span className="caption w-[78px] text-right tabular-nums">
                {cutoff ? fmtDate(cutoff) : "All time"}
              </span>
            </div>
          )}

          {/* Impact-mode legend (graph only, while a node is selected). */}
          {selected && viewMode === "graph" && (
            <div
              className={cn(
                "caption absolute right-3 top-3 flex h-7 items-center gap-3 rounded-full px-3",
                HUD,
              )}
            >
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-foreground" /> impacted
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-info" /> influenced by
              </span>
            </div>
          )}
          {/* Selected node detail card. Read-only: the per-agent memory views it
              used to open were removed with the agent dropdown. */}
          {selected && (
            <div
              className={cn("absolute bottom-3 left-3 max-w-[340px] rounded-lg p-3 text-left", HUD)}
            >
              <div className="mb-1 flex items-center gap-1.5">
                <SourceDot source={selected.source} />
                <span className="label truncate">{selected.summary || selected.title}</span>
              </div>
              <p className="line-clamp-4 text-2xs leading-relaxed text-secondary-foreground">
                {selected.snippet || "—"}
              </p>
              <p className="eyebrow mt-2 text-disabled">
                {selected.source} · {selected.kind}
                {selected.timestampMs > 0 && ` · ${fmtDate(selected.timestampMs)}`}
              </p>
            </div>
          )}
        </div>

        {results.length > 0 && (
          <aside className="hide-scrollbar w-[280px] shrink-0 overflow-y-auto border-l border-border bg-background">
            <div className="eyebrow sticky top-0 z-panel flex h-control-md items-center border-b border-border-subtle bg-background px-3">
              Results
            </div>
            <div className="flex flex-col gap-px p-1.5">
              {results.map((hit) => {
                const node = nodeById.get(hit.id);
                if (!node) return null;
                const active = selectedId === hit.id;
                return (
                  <button
                    key={hit.id}
                    type="button"
                    onClick={() => onSelect(active ? null : hit.id)}
                    className={cn(
                      "flex w-full cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left",
                      "transition-colors duration-fast ease-out-strong",
                      active
                        ? "bg-element-selected hover:bg-element-selected"
                        : "hover:bg-element-hover",
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      <SourceDot source={node.source} />
                      <span className="flex-1 truncate text-sm font-medium text-foreground">
                        {node.title}
                      </span>
                      <span className="caption tabular-nums">{Math.round(hit.score * 100)}%</span>
                    </div>
                    <span className="line-clamp-2 text-2xs leading-snug text-muted-foreground">
                      {node.snippet}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function SourceDot({ source }: { source: string }) {
  // The vendor marks are constants (`agent-brand.ts`); anything else is the
  // theme's own primary.
  const color = agentBrandColor(source) ?? "var(--primary)";
  return <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} />;
}

/** A surface floating over the canvas: the frosted HUD (hairline, raised top
 *  edge, menu-rung shadow) over a translucent fill the blur shows through. */
const HUD = "glass-hud backdrop-blur-glass bg-gradient-to-b from-popover/85 to-card/90";

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
