import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { agentBrandColor } from "@/features/agents/lib/agent-brand";
import type { MemoryGraphData } from "../../lib/memory-graph-types";
import { FixWithAgentButton } from "@/features/ask-agent/components/ask-agent-button";
import { Notice, ProgressBar, SearchField, Toolbar, Track, TrackSegment } from "./memory-chrome";
import { Hint, Button, IconButton } from "@tryatlas/design";

export type MemoryGraphViewMode = "graph" | "tree";

const MODEL_LABEL = "all-MiniLM-L6-v2 · ~90 MB";

/** The memory graph's setup phases (mirrors `MemoryGraphPhase` in the store). */
export type MemoryGraphViewPhase =
  | "checking"
  | "not-downloaded"
  | "downloading"
  | "download-failed"
  | "indexing"
  | "graph-ready"
  | "error";

export interface MemoryGraphViewProps {
  projectOpen: boolean;
  phase: MemoryGraphViewPhase;
  progress: {
    file: string;
    file_index: number;
    file_count: number;
    received: number;
    total: number;
  } | null;
  error: string | null;
  graph: MemoryGraphData | null;
  docCount: number;
  query: string;
  querying: boolean;
  results: { id: string; score: number }[];
  selectedId: string | null;
  viewMode: MemoryGraphViewMode;
  onViewModeChange: (mode: MemoryGraphViewMode) => void;
  onDownload: () => void;
  /** Re-downloads after a failed download, re-inits after an error. */
  onRetry: () => void;
  onQueryChange: (q: string) => void;
  onRunQuery: (q: string) => void;
  onClearQuery: () => void;
  onSelect: (id: string | null) => void;
  onReindex: () => void;
  /** The graph or tree stage for the current view mode, at the scrubber's cutoff. */
  renderStage: (cutoffMs: number | null) => ReactNode;
}

/** The Memory tab's Graph sub-tab: setup screens, then the toolbar, stage,
 *  timeline scrubber, legend, detail card and results rail. Props only. */
export function MemoryGraphView({
  projectOpen,
  phase,
  progress,
  error,
  graph,
  onDownload,
  onRetry,
  ...ready
}: MemoryGraphViewProps) {
  if (!projectOpen) {
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
          <Button size="lg" onClick={onDownload}>
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
          <>
            <Button variant="outline" onClick={onRetry}>
              <RotateCw size={12} />
              Retry
            </Button>
            {error && (
              <FixWithAgentButton
                error={{
                  kind: "error",
                  source:
                    phase === "download-failed"
                      ? "Memory: downloading the embedding model"
                      : "Memory: the map",
                  message: error,
                }}
              />
            )}
          </>
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

  return <GraphReady graph={graph} {...ready} />;
}

type GraphReadyProps = Omit<
  MemoryGraphViewProps,
  "projectOpen" | "phase" | "progress" | "error" | "graph" | "onDownload" | "onRetry"
> & { graph: MemoryGraphData };

function GraphReady({
  graph,
  docCount,
  query,
  querying,
  results,
  selectedId,
  viewMode,
  onViewModeChange,
  onQueryChange,
  onRunQuery,
  onClearQuery,
  onSelect,
  onReindex,
  renderStage,
}: GraphReadyProps) {
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
    <div data-view="memory-graph" className="flex h-full flex-col bg-background">
      {/* Query bar */}
      <Toolbar>
        {/* Tree / Graph toggle — top-left. Tree (the decision tree) is the
            primary view, so it sits first. */}
        <Track>
          <TrackSegment
            active={viewMode === "tree"}
            onClick={() => onViewModeChange("tree")}
            title="Decision tree"
          >
            <ListTree size={11} /> Tree
          </TrackSegment>
          <TrackSegment
            active={viewMode === "graph"}
            onClick={() => onViewModeChange("graph")}
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
          {renderStage(cutoff)}

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

          {/* Impact-mode legend (graph only, while a node is selected). The
              graph's ruler draws a 20px band along the top and left edges
              above everything else, so the graph-mode overlays sit at 26px
              (band + 6) to clear it rather than on the spacing scale. */}
          {selected && viewMode === "graph" && (
            <div
              className={cn(
                "caption absolute top-[26px] right-3 flex h-7 items-center gap-3 rounded-full px-3",
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
              className={cn(
                "absolute bottom-3 max-w-[340px] rounded-lg p-3 text-left",
                viewMode === "graph" ? "left-[26px]" : "left-3",
                HUD,
              )}
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
