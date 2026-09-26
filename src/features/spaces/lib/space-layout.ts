/**
 * Laying out a diagram Atlas Agent draws on a Space page (`org_page_write`).
 *
 * The model sends nodes and edges, positions optional; this decides where
 * everything goes. Pure — no Yjs, no window — so the whole of "readable" is
 * testable here, and `space-diagram.ts` only writes what this placed.
 *
 * The rules:
 *  - a node with `x` and `y` keeps them: canvas coordinates, final;
 *  - the rest are laid out **layered by edge direction**, left to right:
 *    longest-path layering (a node sits one column past the furthest node
 *    that points at it; a cycle is broken where the walk first closes it),
 *    ordered within each column by the barycentre of its neighbours so edges
 *    cross less;
 *  - a **group** is a container: its children are laid out inside it and it
 *    is sized around them (unless `w`/`h` say otherwise), then it is laid
 *    out as one box among its own siblings. The page has no grouping linkage
 *    (the contract has none), so this is where a group's meaning lives;
 *  - unplaced nodes of a container that also holds placed ones go below the
 *    placed ones, so the two never overlap;
 *  - an edge attaches at the anchors it names, else at the sides facing each
 *    other, and carries its label.
 */
import { SPACE_NODE_DEFAULT_SIZE, type SpaceAnchor, type SpaceShapeType } from "./space-doc";

export type DiagramNodeKind = "note" | "text" | "shape" | "group";

/** One node as the tool sends it (Rust has already checked it). */
export interface DiagramNode {
  id: string;
  kind: DiagramNodeKind;
  text?: string;
  shape?: SpaceShapeType;
  /** The id of the group that holds it. */
  parent?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  from_anchor?: SpaceAnchor;
  to_anchor?: SpaceAnchor;
  label?: string;
}

export interface Diagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface PlacedNode {
  /** The model's id for it; the page gets a fresh id of its own. */
  id: string;
  kind: DiagramNodeKind;
  text: string;
  shape: SpaceShapeType | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  fromAnchor: SpaceAnchor;
  toAnchor: SpaceAnchor;
  label: string;
}

/** Groups first (outer before inner), so every frame is drawn beneath what it
 *  holds; then the rest in the order they were given. */
export interface PlacedDiagram {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
}

/** Spacing, in canvas units. */
export const LAYOUT = {
  /** Between two columns of a layered block. */
  columnGap: 120,
  /** Between two nodes of one column. */
  rowGap: 48,
  /** Between a group's frame and what it holds. */
  groupPadding: 32,
  /** Between placed nodes and the laid-out block below them. */
  blockGap: 96,
} as const;

/** A node's size when the model gives none: the canvas's own defaults for
 *  what its toolbar makes (a click-placed shape, text box, note and group). */
export const KIND_SIZE: Record<DiagramNodeKind, { width: number; height: number }> = {
  note: SPACE_NODE_DEFAULT_SIZE,
  text: { width: 240, height: 80 },
  shape: { width: 160, height: 100 },
  group: { width: 320, height: 200 },
};

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const union = (a: Box | null, b: Box | null): Box | null =>
  !a
    ? b
    : !b
      ? a
      : {
          minX: Math.min(a.minX, b.minX),
          minY: Math.min(a.minY, b.minY),
          maxX: Math.max(a.maxX, b.maxX),
          maxY: Math.max(a.maxY, b.maxY),
        };

const boxOf = (x: number, y: number, width: number, height: number): Box => ({
  minX: x,
  minY: y,
  maxX: x + width,
  maxY: y + height,
});

const isPlaced = (n: DiagramNode): n is DiagramNode & { x: number; y: number } =>
  Number.isFinite(n.x) && Number.isFinite(n.y);

interface Block {
  /** Top-left of each item, relative to the block's own top-left. */
  at: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

/**
 * Arrange `items` in layered columns along `links` (pairs of item ids),
 * left to right. Returns each item's top-left relative to the block.
 */
export function layeredBlock(
  items: readonly { id: string; width: number; height: number }[],
  links: readonly (readonly [string, string])[],
): Block {
  const index = new Map(items.map((item, i) => [item.id, i]));
  const out = new Map<string, string[]>();
  for (const item of items) out.set(item.id, []);
  const seenLink = new Set<string>();
  for (const [a, b] of links) {
    const key = `${a}\u0000${b}`;
    if (a === b || !index.has(a) || !index.has(b) || seenLink.has(key)) continue;
    seenLink.add(key);
    out.get(a)!.push(b);
  }

  // A depth-first walk in the given order; an edge back onto the walk's own
  // path closes a cycle and is left out of the layering (the edge is still
  // drawn — it just points backwards).
  const state = new Map<string, 1 | 2>();
  const postorder: string[] = [];
  const forward = new Map<string, string[]>();
  const visit = (id: string) => {
    state.set(id, 1);
    const kept: string[] = [];
    for (const next of out.get(id)!) {
      const s = state.get(next);
      if (s === 1) continue;
      kept.push(next);
      if (s === undefined) visit(next);
    }
    forward.set(id, kept);
    state.set(id, 2);
    postorder.push(id);
  };
  for (const item of items) if (!state.has(item.id)) visit(item.id);

  // Longest path from the sources: one column past the furthest predecessor.
  const layer = new Map<string, number>();
  const preds = new Map<string, string[]>(items.map((i) => [i.id, []]));
  for (const id of [...postorder].reverse()) {
    if (!layer.has(id)) layer.set(id, 0);
    for (const next of forward.get(id)!) {
      layer.set(next, Math.max(layer.get(next) ?? 0, layer.get(id)! + 1));
      preds.get(next)!.push(id);
    }
  }
  const succs = forward;

  const columns: string[][] = [];
  for (const item of items) {
    const l = layer.get(item.id)!;
    (columns[l] ??= []).push(item.id);
  }

  // Barycentre ordering: a node moves toward the average row of the nodes it
  // is joined to in the column before (down sweep) or after (up sweep).
  const row = new Map<string, number>();
  const renumber = (column: string[]) => column.forEach((id, i) => row.set(id, i));
  columns.forEach(renumber);
  const sortBy = (column: string[], neighbours: (id: string) => string[]) => {
    const key = new Map(
      column.map((id) => {
        const ns = neighbours(id);
        return [
          id,
          ns.length ? ns.reduce((sum, n) => sum + row.get(n)!, 0) / ns.length : row.get(id)!,
        ];
      }),
    );
    column.sort((a, b) => key.get(a)! - key.get(b)! || index.get(a)! - index.get(b)!);
    renumber(column);
  };
  for (let round = 0; round < 2; round += 1) {
    for (let l = 1; l < columns.length; l += 1) sortBy(columns[l], (id) => preds.get(id)!);
    for (let l = columns.length - 2; l >= 0; l -= 1) sortBy(columns[l], (id) => succs.get(id)!);
  }

  const size = new Map(items.map((i) => [i.id, i]));
  const colWidth = columns.map((c) => Math.max(...c.map((id) => size.get(id)!.width)));
  const colHeight = columns.map(
    (c) => c.reduce((sum, id) => sum + size.get(id)!.height, 0) + LAYOUT.rowGap * (c.length - 1),
  );
  const height = columns.length ? Math.max(...colHeight) : 0;
  const at = new Map<string, { x: number; y: number }>();
  let x = 0;
  columns.forEach((column, l) => {
    let y = (height - colHeight[l]) / 2;
    for (const id of column) {
      const s = size.get(id)!;
      at.set(id, { x: Math.round(x + (colWidth[l] - s.width) / 2), y: Math.round(y) });
      y += s.height + LAYOUT.rowGap;
    }
    x += colWidth[l] + LAYOUT.columnGap;
  });
  const width = columns.length ? x - LAYOUT.columnGap : 0;
  return { at, width, height };
}

/** The sides of two boxes that face each other: across when they sit more
 *  side by side than stacked, else down or up. */
export function facingAnchors(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
): [SpaceAnchor, SpaceAnchor] {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["e", "w"] : ["w", "e"];
  return dy >= 0 ? ["s", "n"] : ["n", "s"];
}

export function layoutDiagram(diagram: Diagram): PlacedDiagram {
  const byId = new Map(diagram.nodes.map((n) => [n.id, n]));
  /** The group a node is laid out in, or `null` for the page itself. */
  const containerOf = (n: DiagramNode): string | null =>
    n.parent !== undefined && n.parent !== n.id && byId.get(n.parent)?.kind === "group"
      ? n.parent
      : null;
  const children = new Map<string | null, DiagramNode[]>();
  for (const n of diagram.nodes) {
    const c = containerOf(n);
    if (!children.has(c)) children.set(c, []);
    children.get(c)!.push(n);
  }
  const kids = (c: string | null) => children.get(c) ?? [];

  // A node is anchored when it, or anything a group holds, has a position:
  // it then sits where the positions say, not where a block puts it.
  const anchoredMemo = new Map<string, boolean>();
  const anchored = (n: DiagramNode): boolean => {
    const known = anchoredMemo.get(n.id);
    if (known !== undefined) return known;
    anchoredMemo.set(n.id, false); // a loop Rust let through reads as unanchored
    const result = isPlaced(n) || (n.kind === "group" && kids(n.id).some(anchored));
    anchoredMemo.set(n.id, result);
    return result;
  };

  const size = new Map<string, { width: number; height: number }>();
  const local = new Map<string, { x: number; y: number }>();
  const abs = new Map<string, { x: number; y: number }>();
  const ownSize = (n: DiagramNode) => ({
    width: n.w ?? KIND_SIZE[n.kind].width,
    height: n.h ?? KIND_SIZE[n.kind].height,
  });

  /** The item of container `c` a node belongs to — itself or the group
   *  around it that `c` holds directly — or `null` when `c` does not hold it. */
  const liftTo = (id: string, c: string | null): string | null => {
    let at: DiagramNode | undefined = byId.get(id);
    const seen = new Set<string>();
    while (at && !seen.has(at.id)) {
      seen.add(at.id);
      const up = containerOf(at);
      if (up === c) return at.id;
      if (up === null) return null;
      at = byId.get(up);
    }
    return null;
  };

  /** Lay out container `c`'s unplaced children as one block. */
  const block = (c: string | null): Block & { items: DiagramNode[] } => {
    const items = kids(c).filter((n) => !anchored(n));
    for (const item of items) {
      if (item.kind === "group") measureFree(item);
      else size.set(item.id, ownSize(item));
    }
    const ids = new Set(items.map((i) => i.id));
    const links: [string, string][] = [];
    for (const e of diagram.edges) {
      const a = liftTo(e.from, c);
      const b = liftTo(e.to, c);
      if (a && b && a !== b && ids.has(a) && ids.has(b)) links.push([a, b]);
    }
    const laid = layeredBlock(
      items.map((i) => ({ id: i.id, ...size.get(i.id)! })),
      links,
    );
    return { ...laid, items };
  };

  /** Size a group none of whose contents is placed: around its own block. */
  const measureFree = (g: DiagramNode) => {
    const inner = block(g.id);
    const pad = LAYOUT.groupPadding;
    for (const item of inner.items) {
      const p = inner.at.get(item.id)!;
      local.set(item.id, { x: pad + p.x, y: pad + p.y });
    }
    const empty = inner.items.length === 0;
    size.set(g.id, {
      width: g.w ?? (empty ? KIND_SIZE.group.width : inner.width + 2 * pad),
      height: g.h ?? (empty ? KIND_SIZE.group.height : inner.height + 2 * pad),
    });
  };

  const placeFree = (id: string, x: number, y: number) => {
    abs.set(id, { x, y });
    for (const child of kids(id)) {
      const l = local.get(child.id);
      if (l) placeFree(child.id, x + l.x, y + l.y);
    }
  };

  /** Place container `c`'s children; the box around everything placed. */
  const resolve = (c: string | null, origin: { x: number; y: number } | null): Box | null => {
    let box: Box | null = null;
    for (const k of kids(c)) {
      if (!anchored(k)) continue;
      if (k.kind === "group") box = union(box, resolveGroup(k));
      else {
        const s = ownSize(k);
        size.set(k.id, s);
        abs.set(k.id, { x: k.x!, y: k.y! });
        box = union(box, boxOf(k.x!, k.y!, s.width, s.height));
      }
    }
    const laid = block(c);
    if (laid.items.length > 0) {
      const bx = box ? box.minX : (origin?.x ?? 0);
      const by = box ? box.maxY + LAYOUT.blockGap : (origin?.y ?? 0);
      for (const item of laid.items) {
        const p = laid.at.get(item.id)!;
        placeFree(item.id, bx + p.x, by + p.y);
      }
      box = union(box, boxOf(bx, by, laid.width, laid.height));
    }
    return box;
  };

  const resolveGroup = (g: DiagramNode): Box => {
    const pad = LAYOUT.groupPadding;
    if (isPlaced(g)) {
      const content = resolve(g.id, { x: g.x + pad, y: g.y + pad });
      const s = {
        width: g.w ?? (content ? Math.max(content.maxX + pad - g.x, 120) : KIND_SIZE.group.width),
        height: g.h ?? (content ? Math.max(content.maxY + pad - g.y, 80) : KIND_SIZE.group.height),
      };
      size.set(g.id, s);
      abs.set(g.id, { x: g.x, y: g.y });
      return boxOf(g.x, g.y, s.width, s.height);
    }
    // Held in place by something inside it that is placed.
    const content = resolve(g.id, null)!;
    const x = content.minX - pad;
    const y = content.minY - pad;
    const s = {
      width: g.w ?? content.maxX - content.minX + 2 * pad,
      height: g.h ?? content.maxY - content.minY + 2 * pad,
    };
    size.set(g.id, s);
    abs.set(g.id, { x, y });
    return boxOf(x, y, s.width, s.height);
  };

  resolve(null, null);

  const depth = (n: DiagramNode): number => {
    let d = 0;
    for (let c = containerOf(n); c !== null && d <= diagram.nodes.length; d += 1) {
      c = containerOf(byId.get(c)!);
    }
    return d;
  };
  const groups = diagram.nodes
    .filter((n) => n.kind === "group")
    .map((n, i) => ({ n, i, d: depth(n) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((g) => g.n);
  const ordered = [...groups, ...diagram.nodes.filter((n) => n.kind !== "group")];

  const nodes: PlacedNode[] = ordered.map((n) => {
    const p = abs.get(n.id) ?? { x: 0, y: 0 };
    const s = size.get(n.id) ?? ownSize(n);
    return {
      id: n.id,
      kind: n.kind,
      text: n.text ?? "",
      shape: n.kind === "shape" ? (n.shape ?? "rectangle") : null,
      x: Math.round(p.x),
      y: Math.round(p.y),
      width: Math.round(s.width),
      height: Math.round(s.height),
    };
  });
  const placed = new Map(nodes.map((n) => [n.id, n]));
  const edges: PlacedEdge[] = diagram.edges
    .filter((e) => placed.has(e.from) && placed.has(e.to))
    .map((e) => {
      const [fromFacing, toFacing] = facingAnchors(placed.get(e.from)!, placed.get(e.to)!);
      return {
        from: e.from,
        to: e.to,
        fromAnchor: e.from_anchor ?? fromFacing,
        toAnchor: e.to_anchor ?? toFacing,
        label: e.label ?? "",
      };
    });
  return { nodes, edges };
}
