// The ACP shapes the Atlas frontend names directly.
//
// Deliberately small. This file used to mirror a slice of the protocol —
// `SessionUpdate`, `AcpEvent`, and the content/tool/stop-reason types they were
// built from — from when the frontend read the protocol itself. It does not:
// everything from the agent arrives as `AgentDelta` (`./agents.ts`, the frozen
// wire), projected in Rust. Those mirrors had no consumers left and were a
// second, drifting description of a contract that already has one.
//
// What remains is what the frontend actually holds: agent identity, and the
// permission request the modal renders.

export type AgentId = string; // UUID
export type AcpSessionId = string; // ACP session id (string under the hood)

export interface AgentInfo {
  agent_id: AgentId;
  spec_id: string;
  display_name: string;
}

export type PermissionDecision = { kind: "selected"; option_id: string } | { kind: "cancelled" };

/** One option the agent offered for a permission request.
 *
 *  IMPORTANT: the wire field names are camelCase (`optionId`), NOT snake_case.
 *  The agent sends them that way and they are forwarded verbatim; spelling one
 *  `option_id` here reads `undefined` at runtime with no type error. */
export interface PermissionOptionRef {
  optionId: string;
  name: string;
  kind: string;
}

export interface ToolCallRef {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content?: unknown;
  [k: string]: unknown;
}

export interface PendingPermission {
  agentId: AgentId;
  acpSessionId: AcpSessionId;
  requestId: string;
  toolCall: ToolCallRef;
  options: PermissionOptionRef[];
}
