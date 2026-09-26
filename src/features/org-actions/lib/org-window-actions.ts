/**
 * Performing an organisation call that crosses to the window (ADR-0014 over
 * ADR-0012's bridge): a tool whose work needs something only the frontend
 * holds. Rust has already checked the call — the organisation access
 * setting, the grant, the arguments — and resolved what it names to ids, so
 * this reads the ids it was sent and does the work. A plain dispatcher over
 * the tool name, like the UI actions'; the call's Logs row is written from
 * Rust's audit record, as for every organisation call.
 */

import { useCommsStore } from "@/features/comms/stores/comms-store";
import { appSpaceTransport } from "@/features/spaces/lib/live-spaces";
import type { Diagram, DiagramEdge, DiagramNode } from "@/features/spaces/lib/space-layout";
import { PageWriteRefusal, writeSpacePage } from "@/features/spaces/lib/space-page-write";
import type { SpaceAnchor, SpaceShapeType } from "@/features/spaces/lib/space-doc";
import {
  fail,
  ok,
  type UiActionReply,
  type UiActionRequest,
} from "@/features/ui-actions/lib/types";

class Refusal extends Error {}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const oneOf = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

const KINDS = ["note", "text", "shape", "group"] as const;
const SHAPES: readonly SpaceShapeType[] = ["rectangle", "ellipse", "diamond", "triangle"];
const ANCHORS: readonly SpaceAnchor[] = ["n", "e", "s", "w"];

/** The document Rust sent, parsed rather than cast: the window acts only on
 *  what it can read. */
function readDiagram(value: unknown): Diagram {
  const doc = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!doc || !Array.isArray(doc.nodes)) throw new Refusal("the document has no nodes");
  const nodes: DiagramNode[] = doc.nodes.map((raw, i) => {
    const n = (raw ?? {}) as Record<string, unknown>;
    const id = str(n.id);
    const kind = oneOf(KINDS, n.kind);
    if (!id || !kind) throw new Refusal(`node ${i + 1} has no id or kind`);
    return {
      id,
      kind,
      text: typeof n.text === "string" ? n.text : undefined,
      shape: oneOf(SHAPES, n.shape),
      parent: str(n.parent),
      x: num(n.x),
      y: num(n.y),
      w: num(n.w),
      h: num(n.h),
    };
  });
  const edges: DiagramEdge[] = (Array.isArray(doc.edges) ? doc.edges : []).map((raw, i) => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const from = str(e.from);
    const to = str(e.to);
    if (!from || !to) throw new Refusal(`edge ${i + 1} has no from or to`);
    return {
      from,
      to,
      from_anchor: oneOf(ANCHORS, e.from_anchor),
      to_anchor: oneOf(ANCHORS, e.to_anchor),
      label: typeof e.label === "string" ? e.label : undefined,
    };
  });
  return { nodes, edges };
}

/** `org_page_write`: draw the document on the page, through the Space's own
 *  sync. The window's Space socket is the organisation chat's; a call for
 *  another organisation is refused rather than sent to the wrong one. */
async function pageWrite(request: UiActionRequest) {
  const orgId = str(request.args.org_id);
  const convId = str(request.args.conversation_id);
  const pageId = str(request.args.page_id);
  if (!orgId || !convId || !pageId) throw new Refusal("the call names no page");
  const chatOrg = useCommsStore.getState().connection.orgId;
  if (chatOrg !== orgId) {
    throw new Refusal(
      "the Atlas window's organisation chat is not on this chat's organisation; ask the user to switch to it",
    );
  }
  return writeSpacePage(appSpaceTransport, { convId, pageId }, readDiagram(request.args.document));
}

export async function performOrgWindowAction(request: UiActionRequest): Promise<UiActionReply> {
  try {
    switch (request.tool) {
      case "org_page_write":
        return ok(await pageWrite(request));
      default:
        return fail(`unknown organisation window action "${request.tool}"`);
    }
  } catch (e) {
    if (e instanceof PageWriteRefusal) return fail(e.message);
    if (e instanceof Refusal) return fail(`${e.message}. Nothing was drawn.`);
    return fail(`${request.tool} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
