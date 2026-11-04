// Thin TS wrapper around the knowledge graph's layout commands
// (`src-tauri/src/commands/knowledge_graph_layout.rs`).

import { invoke } from "@tauri-apps/api/core";
import type { GraphLayout } from "./knowledge-graph-model";

/** Saved node positions for the project; none on disk or an error → empty. */
export async function loadGraphLayout(projectPath: string): Promise<GraphLayout> {
  try {
    const l = await invoke<GraphLayout | null>("knowledge_graph_layout_load", { projectPath });
    return l ?? { positions: {} };
  } catch {
    return { positions: {} };
  }
}

/** Best-effort: a failed save only loses positions, so errors are swallowed. */
export function saveGraphLayout(projectPath: string, layout: GraphLayout): void {
  invoke("knowledge_graph_layout_save", { projectPath, layout }).catch(() => {});
}
