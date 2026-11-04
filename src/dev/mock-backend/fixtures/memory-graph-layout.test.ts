import { describe, expect, it } from "vitest";
import type {
  GraphLayout,
  MemoryGraphData,
} from "@/features/memory/components/memory-graph-canvas";
import { MOCK_PROJECT } from "../project";
import { memoryHandlers } from "./memory";

// `memory_graph_layout_save` is a pure passthrough in Rust
// (`commands/memory_graph.rs`) — it only ever persists px positions the
// frontend's live Matter world already had, and that world is walled to
// [0,width]×[0,height] (`memory-graph-scene.ts`'s wall bodies), top-left
// origin. A real saved layout can therefore never sit near (0,0)-centred
// negative coordinates; nothing in the live sim would push a node there and
// leave it. A fixture seed that gets this wrong renders a graph with a
// correct node/link count but an empty-looking canvas — nodes exist, are
// drawn, and sit permanently off-screen with no restoring force to bring
// them back. This is a regression guard for that failure mode, not a
// pixel-perfect layout check.
describe("memory graph mock fixture: seeded layout", () => {
  const graph = memoryHandlers.memory_index_build({
    projectPath: MOCK_PROJECT.path,
  }) as MemoryGraphData & { doc_count: number };
  const layout = memoryHandlers.memory_graph_layout_load({
    projectPath: MOCK_PROJECT.path,
  }) as GraphLayout;

  it("seeds a node sprite for every one of the corpus's nodes", () => {
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.nodes.length).toBe(graph.doc_count);
  });

  it("only places nodes that exist in the graph", () => {
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    for (const id of Object.keys(layout.positions)) {
      expect(nodeIds.has(id)).toBe(true);
    }
  });

  it("keeps every saved position within a plausible on-canvas range", () => {
    const ids = Object.keys(layout.positions);
    // The fixture is documented to place all but 3 of the corpus's nodes
    // (the rest fall back to the force layout) — assert that shape rather
    // than a magic number, so the guard survives the corpus growing.
    expect(ids.length).toBe(graph.nodes.length - 3);
    for (const [id, pos] of Object.entries(layout.positions)) {
      expect(pos.x, `${id}.x should be on-canvas`).toBeGreaterThan(0);
      expect(pos.y, `${id}.y should be on-canvas`).toBeGreaterThan(0);
      expect(pos.x, `${id}.x should be on-canvas`).toBeLessThan(1000);
      expect(pos.y, `${id}.y should be on-canvas`).toBeLessThan(1000);
    }
  });
});
