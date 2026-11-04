import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useKnowledgeStore } from "../stores/knowledge-store";
import { useKnowledgeMetaStore } from "../stores/knowledge-meta-store";
import { useKnowledgeGraphStore, useProjectGraph } from "../stores/knowledge-graph-store";
import { loadGraphLayout, saveGraphLayout } from "../lib/knowledge-graph-api";
import { NODE_CAP, type GraphLayout, type ProjectGraph } from "../lib/knowledge-graph-model";
import { KnowledgeGraphView, type KnowledgeGraphStatus } from "./views/knowledge-graph-view";

export type { GraphLayout } from "../lib/knowledge-graph-model";

/** The Knowledge Graph tab: store and IPC wiring for `KnowledgeGraphView`. */
export function KnowledgeGraph() {
  const currentProject = useAppStore.use.currentProject();
  const projectPath = currentProject?.path ?? null;
  const { bind, unbind } = useKnowledgeGraphStore.use.actions();
  const { addTab } = useLayoutStore.use.actions();
  const { selectEntry } = useKnowledgeStore.use.actions();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { graph: rawGraph, loading } = useProjectGraph();
  const metaPages = useKnowledgeMetaStore.use.pages();

  // Persisted positions — loaded once per project, then handed to the scene
  // as the initial body layout. Tagged with the project they belong to, so a
  // switch shows "loading" until the new project's positions are in.
  const [layout, setLayout] = useState<{ path: string; layout: GraphLayout } | undefined>();
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    void loadGraphLayout(projectPath).then((l) => {
      if (!cancelled) setLayout({ path: projectPath, layout: l });
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    if (projectPath) void bind(projectPath);
    return () => unbind();
  }, [projectPath, bind, unbind]);

  // Override node titles with `meta.title` when set — the wire-side
  // title from Rust is the filename, so this is the user-edited
  // page-header label.
  const graph = useMemo<ProjectGraph>(() => {
    if (!rawGraph.nodes.length) return rawGraph;
    return {
      ...rawGraph,
      nodes: rawGraph.nodes.map((n) => {
        const override = metaPages[n.id]?.title?.trim();
        return override ? { ...n, title: override } : n;
      }),
    };
  }, [rawGraph, metaPages]);

  const currentLayout = layout && layout.path === projectPath ? layout.layout : undefined;
  const status: KnowledgeGraphStatus = !projectPath
    ? "no-project"
    : loading
      ? "loading"
      : graph.nodes.length === 0
        ? "empty"
        : graph.nodes.length > NODE_CAP
          ? "too-large"
          : currentLayout === undefined
            ? "loading"
            : "ready";

  return (
    <KnowledgeGraphView
      status={status}
      graph={graph}
      layout={currentLayout}
      selectedId={selectedId}
      onSelect={setSelectedId}
      onActivate={(entryId) => {
        addTab({
          id: "knowledge",
          type: "knowledge",
          title: "Knowledge",
          closable: true,
          dirty: false,
          data: {},
        });
        selectEntry(entryId);
      }}
      onLayoutChange={(l) => {
        if (projectPath) saveGraphLayout(projectPath, l);
      }}
    />
  );
}
