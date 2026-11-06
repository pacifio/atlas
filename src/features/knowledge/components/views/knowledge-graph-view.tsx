import { useLayoutEffect, useRef, useState } from "react";
import { FolderOpen, Network } from "lucide-react";
import { EmptyState, Spinner } from "@tryatlas/design";
import { NODE_CAP, type GraphLayout, type ProjectGraph } from "../../lib/knowledge-graph-model";
import { KnowledgeGraphCanvas } from "./knowledge-graph-canvas";

export type KnowledgeGraphStatus = "no-project" | "loading" | "empty" | "too-large" | "ready";

/** The Knowledge Graph tab: a status screen, or the measured graph canvas. */
export function KnowledgeGraphView({
  status,
  graph,
  layout,
  selectedId,
  onSelect,
  onActivate,
  onLayoutChange,
}: {
  status: KnowledgeGraphStatus;
  graph: ProjectGraph;
  /** Saved positions; required once `status` is `ready`. */
  layout?: GraphLayout;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
  onLayoutChange: (layout: GraphLayout) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Skip 0×0 reports — they happen every time this tab is hidden
      // (`display: none` in the persistent-tab container collapses
      // layout). Acting on them would rebuild the entire Pixi scene
      // and wipe node positions on every tab switch.
      if (width === 0 || height === 0) return;
      setSize({
        width: Math.max(200, Math.floor(width)),
        height: Math.max(200, Math.floor(height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={containerRef} data-view="knowledge-graph" className="relative h-full w-full bg-panel">
      {status === "no-project" ? (
        <EmptyState className="h-full" icon={FolderOpen} title="Open a project first" />
      ) : status === "loading" ? (
        <div className="flex h-full w-full items-center justify-center gap-2 text-muted-foreground">
          <Spinner size="sm" label="" />
          <span className="text-xs">Building graph…</span>
        </div>
      ) : status === "empty" ? (
        <EmptyState
          className="h-full"
          icon={Network}
          title="No notes yet"
          description="Create some and reference them with [[note-id]] to see them connect here."
        />
      ) : status === "too-large" ? (
        <EmptyState
          className="h-full"
          icon={Network}
          title={`Graph too large — ${graph.nodes.length} nodes (cap ${NODE_CAP}).`}
        />
      ) : size.width > 0 && size.height > 0 && layout ? (
        <KnowledgeGraphCanvas
          graph={graph}
          width={size.width}
          height={size.height}
          selectedId={selectedId}
          onSelect={onSelect}
          onActivate={onActivate}
          initialLayout={layout}
          onLayoutChange={onLayoutChange}
        />
      ) : null}
    </div>
  );
}
