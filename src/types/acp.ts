// ACP schema mirror — only the bits the Atlas frontend touches directly. Most
// of the schema is forwarded through as opaque `unknown`; phase-2 widgets will
// pull stronger types out of `SessionUpdate` variants as they need them.

export type AgentId = string; // UUID
export type AcpSessionId = string; // ACP session id (string under the hood)

export interface AgentInfo {
  agent_id: AgentId;
  spec_id: string;
  display_name: string;
}

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export type PermissionDecision = { kind: "selected"; option_id: string } | { kind: "cancelled" };

// `SessionUpdate` in the schema is a discriminated union by `sessionUpdate`.
// We pin the variants we care about and leave the rest opaque.
export type ContentBlockText = { type: "text"; text: string };
export type ContentBlock =
  | ContentBlockText
  | { type: "image"; [k: string]: unknown }
  | { type: "tool_use"; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export interface PlanEntry {
  content: string;
  priority?: string;
  status: "pending" | "in_progress" | "completed";
}

// Wire schema uses camelCase via serde rename_all. Field names below MUST
// match the agent-client-protocol-schema crate (see tool_call.rs).
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface ToolLocation {
  path: string;
  line?: number;
}

export type SessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content: ContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content: ContentBlock }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      title?: string;
      kind?: ToolKind;
      status?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      locations?: ToolLocation[];
      content?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      title?: string;
      kind?: ToolKind;
      status?: string;
      rawInput?: unknown;
      rawOutput?: unknown;
      locations?: ToolLocation[];
      content?: unknown;
    }
  | { sessionUpdate: "plan"; entries: PlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: string }
  | { sessionUpdate: "current_model_update"; currentModelId: string };

// IMPORTANT: ACP schema uses #[serde(rename_all = "camelCase")] — wire field
// names are camelCase (optionId), NOT snake_case. Don't `option_id` here.
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

export type AcpEvent =
  | { kind: "agent_disconnected"; reason: string }
  | {
      kind: "session_update";
      session_id: AcpSessionId;
      update: SessionUpdate;
    }
  | {
      kind: "permission_request";
      request_id: string;
      session_id: AcpSessionId;
      tool_call: ToolCallRef;
      options: PermissionOptionRef[];
    }
  | {
      kind: "turn_stopped";
      session_id: AcpSessionId;
      turn_id: string;
      stop_reason: StopReason;
    }
  | {
      kind: "turn_failed";
      session_id: AcpSessionId;
      turn_id: string;
      error: string;
    };
