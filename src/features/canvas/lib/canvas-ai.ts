// Canvas AI protocol — the copilot replies with a strict JSON "ops" program that
// the store applies to build/modify a grouped diagram. Backend-agnostic (works
// with any BYOK text model); the model only ever emits ops, never prose that we
// render. Mirrors the diagram-DSL approach: tempIds + relative coords.

import type {
  AiOp,
  CanvasEdge,
  CanvasNode,
  ShapeType,
} from "../stores/canvas-store";

/** System prompt handed to the BYOK model on every generate/modify turn. */
export const CANVAS_AI_SYSTEM = `You are Atlas's diagramming copilot for an infinite canvas. You turn a request into a diagram/flowchart/notes by emitting a STRICT JSON program of operations — never prose.

Reply with ONLY a fenced code block:
\`\`\`json
{ "ops": [ ... ] }
\`\`\`

Op types:
- {"op":"add_node","tempId":"a","kind":"shape","shapeType":"rectangle|rounded|ellipse|diamond","text":"label","x":0,"y":0,"width":160,"height":90}
- {"op":"add_node","tempId":"n1","kind":"note","title":"Title","body":"markdown body"}
- {"op":"add_node","tempId":"t1","kind":"text","text":"free text"}
- {"op":"connect","from":"a","to":"b"}   // from/to are tempIds of add_node ops, or existing node ids when modifying
- {"op":"update_node","id":"<existing id>","text":"...","title":"...","body":"...","shapeType":"..."}
- {"op":"delete_node","id":"<existing id>"}
- {"op":"delete_edge","id":"<existing edge id>"}

Rules:
- Coordinates (x,y) are RELATIVE to the group's top-left and OPTIONAL — if you omit them for a multi-node diagram, the app auto-lays-out the graph, so prefer omitting coords for flowcharts and only set them for precise placement.
- Use "shape" (rectangle for steps/services, diamond for decisions, ellipse for start/end) + "connect" for flowcharts and architecture diagrams. Use "note" for prose blocks.
- Keep labels short. Do NOT invent facts about the codebase beyond the provided context.
- When MODIFYING an existing diagram, the current nodes/edges are given with their ids — use update_node/delete_node/connect against those ids, and add_node for new pieces.
- Output the JSON block and nothing else.`;

/** Tolerantly extract the ops array from a model reply (fenced ```json block, or a
 *  bare object, or the first {...} span). Returns [] if nothing valid parses. */
export function parseOps(reply: string): AiOp[] {
  const candidates: string[] = [];
  const fence = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(reply.trim());
  // Last resort: the widest {...} span.
  const first = reply.indexOf("{");
  const last = reply.lastIndexOf("}");
  if (first !== -1 && last > first)
    candidates.push(reply.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as { ops?: unknown };
      const ops = Array.isArray(obj?.ops)
        ? obj.ops
        : Array.isArray(obj)
          ? obj
          : null;
      if (ops) return sanitize(ops as unknown[]);
    } catch {
      /* try next candidate */
    }
  }
  return [];
}

const NODE_KINDS = new Set(["shape", "note", "text"]);
const SHAPES = new Set(["rectangle", "rounded", "ellipse", "diamond"]);

function sanitize(raw: unknown[]): AiOp[] {
  const out: AiOp[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    switch (o.op) {
      case "add_node": {
        if (typeof o.tempId !== "string" || !NODE_KINDS.has(o.kind as string))
          break;
        const shapeType = SHAPES.has(o.shapeType as string)
          ? (o.shapeType as ShapeType)
          : undefined;
        out.push({
          op: "add_node",
          tempId: o.tempId,
          kind: o.kind as "shape" | "note" | "text",
          shapeType,
          text: str(o.text),
          title: str(o.title),
          body: str(o.body),
          icon: str(o.icon),
          x: num(o.x),
          y: num(o.y),
          width: num(o.width),
          height: num(o.height),
        });
        break;
      }
      case "connect":
        if (typeof o.from === "string" && typeof o.to === "string")
          out.push({ op: "connect", from: o.from, to: o.to });
        break;
      case "update_node":
        if (typeof o.id === "string")
          out.push({
            op: "update_node",
            id: o.id,
            text: str(o.text),
            title: str(o.title),
            body: str(o.body),
            shapeType: SHAPES.has(o.shapeType as string)
              ? (o.shapeType as ShapeType)
              : undefined,
          });
        break;
      case "delete_node":
        if (typeof o.id === "string") out.push({ op: "delete_node", id: o.id });
        break;
      case "delete_edge":
        if (typeof o.id === "string") out.push({ op: "delete_edge", id: o.id });
        break;
    }
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Current members of a group, compacted for a "modify this diagram" prompt. */
export function serializeGroup(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  groupId: string,
): string {
  const members = nodes.filter((n) => n.groupId === groupId);
  const ids = new Set(members.map((n) => n.id));
  const es = edges.filter(
    (e) => e.groupId === groupId || (ids.has(e.source) && ids.has(e.target)),
  );
  const shape = {
    nodes: members.map((n) => ({
      id: n.id,
      kind: n.kind,
      shapeType: n.shapeType,
      text: n.kind === "note" ? n.title : n.text,
    })),
    edges: es.map((e) => ({ id: e.id, from: e.source, to: e.target })),
  };
  return JSON.stringify(shape);
}
