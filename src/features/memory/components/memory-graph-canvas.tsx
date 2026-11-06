import { useEffect, useState } from "react";
import { memoryGraph } from "../lib/memory-graph-api";
import type { GraphLayout, MemoryGraphData } from "../lib/memory-graph-types";
import { MemoryGraphCanvasView } from "./views/memory-graph-canvas-view";

export type {
  GraphLayout,
  MemoryEdge,
  MemoryGraphData,
  MemoryNode,
} from "../lib/memory-graph-types";

/**
 * The memory force graph's container: loads the saved layout for the project,
 * renders the canvas once it is in, and saves positions back. Keyed on the
 * project so a switch rebuilds the scene and flushes the old layout to the old
 * project's path.
 */
export function MemoryGraphCanvas({
  graph,
  projectPath,
  selectedId,
  matchedIds,
  cutoffMs,
  onSelect,
  onActivate,
}: {
  graph: MemoryGraphData;
  projectPath: string;
  selectedId: string | null;
  matchedIds: Set<string>;
  cutoffMs: number | null;
  onSelect: (id: string | null) => void;
  onActivate: (id: string) => void;
}) {
  const [layout, setLayout] = useState<{ path: string; layout: GraphLayout } | undefined>();

  useEffect(() => {
    let cancelled = false;
    memoryGraph
      .layoutLoad(projectPath)
      .then((l) => {
        if (!cancelled) setLayout({ path: projectPath, layout: l ?? { positions: {} } });
      })
      .catch(() => {
        if (!cancelled) setLayout({ path: projectPath, layout: { positions: {} } });
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  if (!layout || layout.path !== projectPath) return <div className="h-full w-full bg-panel" />;
  return (
    <MemoryGraphCanvasView
      key={projectPath}
      graph={graph}
      initialLayout={layout.layout}
      selectedId={selectedId}
      matchedIds={matchedIds}
      cutoffMs={cutoffMs}
      onSelect={onSelect}
      onActivate={onActivate}
      onLayoutSave={(l) => void memoryGraph.layoutSave(projectPath, l).catch(() => {})}
    />
  );
}
