/**
 * An **outward action**'s approval card (CONTEXT.md; ADR-0014): a call on the
 * organisation tool server that reaches another person in the user's name —
 * a reply on a comment thread, a message — stopped before anything leaves the
 * device.
 *
 * Only the organisation server's outward tools ever ask: every other tool on
 * it is auto-approved, so an organisation call that reaches the approval card
 * is an outward action by construction. And only the native agent's cards can
 * match: `atlas_org` is offered only to a connection that carries
 * organisation access (the in-process native connection, never an ACP one),
 * so an ACP agent's card never names one of its tools. The native seam titles the card with
 * the act ("Reply on Ada Lovelace's comment") and gives the call two text
 * blocks, the recipient and then the full body
 * (`crates/atlas-native-agent/src/engine/tool_approvals.rs`); the wire keeps
 * the tool's own name beside the title (`permission_tool_call`,
 * `crates/atlas-agent-delta/src/project.rs`).
 */

import type { ToolCallRef } from "@/types/acp";
import { orgToolOf } from "./org-tool-rows";

export interface OutwardApproval {
  /** The act and whom it reaches: "Reply on Ada Lovelace's comment". */
  title: string;
  /** Who and where it reaches, in full. */
  recipient: string;
  /** The exact words that will be posted, never shortened. */
  body: string;
}

/** The card's text, or `null` for any approval that is not an outward
 *  action (or one the host could not describe, which keeps the plain card). */
export function outwardApprovalOf(toolCall: ToolCallRef): OutwardApproval | null {
  const toolName = typeof toolCall.toolName === "string" ? toolCall.toolName : "";
  if (orgToolOf(toolName) === null) return null;
  const content = Array.isArray(toolCall.content)
    ? toolCall.content.filter((c): c is string => typeof c === "string")
    : [];
  const title = typeof toolCall.title === "string" ? toolCall.title.trim() : "";
  if (content.length < 2 || !title) return null;
  const [recipient, ...body] = content;
  return { title, recipient, body: body.join("\n") };
}
