// Hierarchy builder + tidy left→right layout for the Memory "Tree" view.
//
// The force graph (memory-graph-canvas) is great for seeing the whole web, but
// on a big project it's a hairball. The tree view turns the SAME graph payload
// into a readable mind-map: a synthetic project root → one branch per memory
// `kind` (category) → memory leaves, with wikilinked memories NESTED under the
// memory that references them (so an agent's decision/reasoning chains read as
// nested branches). Pure functions — no DOM, no deps.

import type {
  MemoryGraphData,
  MemoryNode,
} from "../components/memory-graph-canvas";

export interface TreeNode {
  /** Stable id. Memory nodes use the memory id; synthetic nodes use `root` /
   *  `cat:<kind>`. */
  id: string;
  label: string;
  /** Category key driving the branch colour. */
  kind: string;
  depth: number;
  /** Present for real memory nodes; undefined for the root and category nodes. */
  node?: MemoryNode;
  children: TreeNode[];
}

// Friendly labels + a stable display order for the known memory categories.
const CATEGORY_ORDER = [
  "project",
  "feedback",
  "user",
  "reference",
  "instruction",
  "thread",
  "index",
  "memory",
];
const CATEGORY_LABEL: Record<string, string> = {
  project: "Project",
  feedback: "Feedback",
  user: "User",
  reference: "Reference",
  instruction: "Instructions",
  thread: "Threads",
  index: "Index",
  memory: "Memory",
};

function categoryLabel(kind: string): string {
  return (
    CATEGORY_LABEL[kind] ??
    (kind ? kind[0].toUpperCase() + kind.slice(1) : "Other")
  );
}

function categoryRank(kind: string): number {
  const i = CATEGORY_ORDER.indexOf(kind);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

/**
 * Build the tree from the graph. Each memory's parent is the `from` of its
 * strongest incoming wikilink (`kind === "link"`, oriented older→newer, so the
 * parent is always older ⇒ acyclic); memories with no such link hang under
 * their category branch. Similarity edges are ignored for nesting.
 */
export function buildMemoryTree(
  graph: MemoryGraphData,
  rootLabel: string,
): TreeNode {
  const byId = new Map<string, MemoryNode>();
  for (const n of graph.nodes) byId.set(n.id, n);

  // Choose at most one wikilink parent per node: the most recent (newest `from`)
  // referencing memory, which keeps decision chains shallow and deterministic.
  const parentOf = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.kind !== "link") continue;
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const cur = parentOf.get(e.to);
    if (cur === undefined) {
      parentOf.set(e.to, e.from);
    } else {
      // Prefer the more recent parent.
      const a = byId.get(cur)?.timestampMs ?? 0;
      const b = byId.get(e.from)?.timestampMs ?? 0;
      if (b > a) parentOf.set(e.to, e.from);
    }
  }

  // Cycle guard: walk parent pointers; if we loop back to the node, drop its
  // parent (falls back to category). Timestamp orientation makes this rare.
  for (const id of parentOf.keys()) {
    const seen = new Set<string>([id]);
    let p = parentOf.get(id);
    while (p !== undefined) {
      if (seen.has(p)) {
        parentOf.delete(id);
        break;
      }
      seen.add(p);
      p = parentOf.get(p);
    }
  }

  const treeById = new Map<string, TreeNode>();
  for (const n of graph.nodes) {
    treeById.set(n.id, {
      id: n.id,
      // Prefer the natural-language summary over the slug filename/title.
      label: n.summary || n.title || n.id,
      kind: n.kind,
      depth: 0,
      node: n,
      children: [],
    });
  }

  // Category branch nodes, created lazily as memories need them.
  const categories = new Map<string, TreeNode>();
  const ensureCategory = (kind: string): TreeNode => {
    let c = categories.get(kind);
    if (!c) {
      c = {
        id: `cat:${kind}`,
        label: categoryLabel(kind),
        kind,
        depth: 1,
        children: [],
      };
      categories.set(kind, c);
    }
    return c;
  };

  for (const n of graph.nodes) {
    const self = treeById.get(n.id)!;
    const parentId = parentOf.get(n.id);
    const parent = parentId ? treeById.get(parentId) : undefined;
    if (parent) parent.children.push(self);
    else ensureCategory(n.kind || "memory").children.push(self);
  }

  const root: TreeNode = {
    id: "root",
    label: rootLabel,
    kind: "root",
    depth: 0,
    children: Array.from(categories.values()).sort(
      (a, b) =>
        categoryRank(a.kind) - categoryRank(b.kind) ||
        a.label.localeCompare(b.label),
    ),
  };

  // Sort each level: memory children newest-first, then assign depths.
  const sortRec = (t: TreeNode, depth: number) => {
    t.depth = depth;
    if (t.node) {
      t.children.sort(
        (a, b) => (b.node?.timestampMs ?? 0) - (a.node?.timestampMs ?? 0),
      );
    }
    for (const c of t.children) sortRec(c, depth + 1);
  };
  sortRec(root, 0);
  return root;
}

export interface TreeLayout {
  positions: Map<string, { x: number; y: number }>;
  /** Flattened, in render order (parents before children), honouring collapse. */
  visible: TreeNode[];
  width: number;
  height: number;
}

/** Column width (x per depth) and row height (y per leaf). Sized to fit a
 *  fixed-width card per node with breathing room so labels never collide. */
export const COL_W = 270;
export const ROW_H = 66;
/** Card geometry (the view renders each node as a 3-line card of this size). */
export const CARD_W = 198;
export const CARD_H = 54;

/**
 * Tidy left→right dendrogram. `x = depth * COL_W`; leaves get sequential rows,
 * internal nodes centre on their visible children's span. Collapsed subtrees
 * contribute one row (the collapsed node) and are not descended into.
 */
export function layoutTree(
  root: TreeNode,
  collapsed: ReadonlySet<string>,
): TreeLayout {
  const positions = new Map<string, { x: number; y: number }>();
  const visible: TreeNode[] = [];
  let row = 0;
  let maxDepth = 0;

  const walk = (t: TreeNode): number => {
    visible.push(t);
    maxDepth = Math.max(maxDepth, t.depth);
    const x = t.depth * COL_W;
    const kids = collapsed.has(t.id) ? [] : t.children;
    let y: number;
    if (kids.length === 0) {
      y = row * ROW_H;
      row += 1;
    } else {
      const ys = kids.map((c) => walk(c));
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    positions.set(t.id, { x, y });
    return y;
  };
  walk(root);

  return {
    positions,
    visible,
    width: (maxDepth + 1) * COL_W,
    height: Math.max(1, row) * ROW_H,
  };
}

// Monochromatic by design — Atlas is AMOLED-black + grays, so connectors and
// lead-in lines are a single muted gray; emphasis comes from the click-to-
// highlight path (handled in the view), not from per-category colour.
export const LINE_MONO = "#5e5e5e";
