/**
 * The memory graph's wire shapes. `MemoryEdge` mirrors Rust `GraphEdge` in
 * `src-tauri/src/commands/memory_graph.rs` (`wire-shape-contract.test.ts`).
 */

export interface MemoryNode {
  id: string;
  title: string;
  /** Natural-language one-liner for display (falls back to title). */
  summary: string;
  kind: string;
  source: string; // "claude" | "codex"
  snippet: string;
  degree: number;
  timestampMs: number;
}
export interface MemoryEdge {
  // Oriented older → newer: `from` plausibly influenced `to`.
  from: string;
  to: string;
  /** Cosine similarity for a `similarity` edge; always 1 for an explicit `link`. */
  weight: number;
  kind: string; // "similarity" | "link"
}
export interface MemoryGraphData {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
}
/** Per-node world-space positions, saved per project. */
export interface GraphLayout {
  positions: Record<string, { x: number; y: number }>;
}
