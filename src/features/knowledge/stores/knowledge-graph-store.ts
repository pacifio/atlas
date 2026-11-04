import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createSelectors } from "@/lib/create-selectors";
import type { ProjectGraph } from "../lib/knowledge-graph-model";

export type { GraphEdge, GraphNode, ProjectGraph } from "../lib/knowledge-graph-model";

interface KnowledgeGraphState {
  projectPath: string | null;
  /** Cached graph for the bound project. `null` while the first
   *  invoke is still in flight (shows "Loading…" instead of the
   *  empty-state flash). */
  graph: ProjectGraph | null;
  actions: {
    bind: (projectPath: string) => Promise<void>;
    unbind: () => void;
  };
}

let unlisten: UnlistenFn | null = null;

async function fetchGraph(projectPath: string): Promise<ProjectGraph> {
  try {
    return await invoke<ProjectGraph>("knowledge_links_graph", { projectPath });
  } catch {
    return { nodes: [], edges: [] };
  }
}

const store = create<KnowledgeGraphState>()((set, get) => ({
  projectPath: null,
  graph: null,
  actions: {
    bind: async (projectPath) => {
      // Re-bind to the same project: keep the cached graph (avoid
      // flashing "Loading…" on a tab re-open) but listen fresh.
      if (get().projectPath === projectPath && unlisten) return;
      get().actions.unbind();
      set({ projectPath, graph: null });

      // Kick off the initial fetch + subscribe in parallel so the
      // listener catches any save events that fire mid-load.
      unlisten = await listen<{ projectPath: string }>(
        "atlas:knowledge:links-changed",
        async (event) => {
          const current = get().projectPath;
          if (!current || event.payload?.projectPath !== current) return;
          const next = await fetchGraph(current);
          // Bail if the project changed under us mid-fetch.
          if (get().projectPath !== current) return;
          set({ graph: next });
        },
      );

      const initial = await fetchGraph(projectPath);
      if (get().projectPath !== projectPath) return;
      set({ graph: initial });
    },
    unbind: () => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      set({ projectPath: null, graph: null });
    },
  },
}));

export const useKnowledgeGraphStore = createSelectors(store);

/** Hook: returns the cached graph + loading flag.
 *  - `loading` is true only on the first hydrate per project bind.
 *  - After that, the cached graph is returned synchronously and
 *    updates in-place when Rust emits `links-changed`. */
export function useProjectGraph(): { graph: ProjectGraph; loading: boolean } {
  const projectPath = useKnowledgeGraphStore.use.projectPath();
  const graph = useKnowledgeGraphStore.use.graph();
  return {
    graph: graph ?? { nodes: [], edges: [] },
    loading: projectPath !== null && graph === null,
  };
}
