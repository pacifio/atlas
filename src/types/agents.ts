import type { ToolContentBlock } from "@/types/agent";

// Wire shapes for the `atlas-agents` Rust surface. These mirror
// `crates/atlas-agents/src/{session,events,plugin,manager}.rs` — keep in sync
// when the Rust types change.

import type { AgentId, AcpSessionId } from "./acp";

export interface SessionKey {
  agent_id: AgentId;
  session_id: AcpSessionId;
}

/** Metadata returned by `agents_new_session` before the binding is exposed. */
export interface SessionInit {
  key: SessionKey;
  current_mode: string | null;
  available_modes: SessionModeInfo[];
}
/** One image attached to an outbound prompt. Mirrors atlas-acp's
 *  `ImageAttachment` (serde camelCase). `dataBase64` is raw base64 — no
 *  `data:` URI prefix. */
export interface ImageAttachment {
  mimeType: string;
  dataBase64: string;
}

export type SessionStatus = "idle" | "running" | "waiting" | "error";
export type MessageRole = "user" | "assistant" | "system";
export type MessageMode = "text" | "tool" | "thinking";
export type ToolCallStatus = "pending" | "running" | "completed" | "failed";

export interface ToolCall {
  id: string;
  tool_name: string;
  title: string | null;
  kind: string | null;
  status: ToolCallStatus;
  arguments: unknown;
  result: string | null;
  locations: unknown[];
  /** Structural content blocks (P1.4). Omitted by Rust when empty. */
  content_blocks?: ToolContentBlock[];
}

export interface PlanEntry {
  content: string;
  priority?: string;
  status: string;
}

export interface SessionMessage {
  id: string;
  role: MessageRole;
  mode: MessageMode;
  content: string;
  thinking?: string;
  tool_calls: ToolCall[];
  plan?: PlanEntry[];
  /** Model that produced this assistant message (stamped live or recovered
   *  from the transcript on replay). Absent for user messages / old records. */
  model?: string | null;
  /** Images a user message carried. Absent when there are none — the Rust
   *  side omits the key rather than sending an empty list. */
  images?: MessageImage[];
  timestamp: string;
}

/** An image on a snapshot `SessionMessage` (`atlas_agent_wire::MessageImage`). */
export interface MessageImage {
  mime_type: string;
  data: string;
}

/** One rolling quota window from the native engine's account report. */
export interface RateLimitWindow {
  /** 0–100. */
  used_percent: number;
  window_minutes: number | null;
  /** Epoch seconds. */
  resets_at: number | null;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /** Reasoning / thinking output, when the agent reports it apart from
   *  `output_tokens` (the native engine does). Informational. */
  reasoning_tokens?: number;
  /** Cumulative cost as the AGENT reported it; 0 when it reported none
   *  (every ACP adapter today) — the renderer estimates from pricing then. */
  cost?: number;
  /** ISO 4217 code `cost` is in; null/absent means USD. */
  currency?: string | null;
}

/** One ACP-advertised session mode (e.g. Codex's read-only / auto / full-access). */
export interface SessionModeInfo {
  id: string;
  name: string;
  description?: string | null;
}

/** What `native_agent_refresh_models` returns — the picker's Refresh for the
 *  native agent (ADR-0007). Mirrors Rust `NativeModelsRefresh`. */
export interface NativeModelsRefresh {
  models: SessionModeInfo[];
  /** The first entitled row: what a new session starts on. */
  defaultModel: string;
  /** Anything the user can see changed. */
  changed: boolean;
  /** The native connection was restarted so the engine picks up the new
   *  rows; open native sessions were told and rebind on their next send. */
  reconnected: boolean;
}

export interface SessionSnapshot {
  agent_id: AgentId;
  session_id: AcpSessionId;
  cwd: string;
  plugin_id: string;
  status: SessionStatus;
  current_mode: string | null;
  current_model: string | null;
  available_modes: SessionModeInfo[];
  /** Models the agent advertised. ACP has no `models` field on a session: an
   *  agent offering a choice says so with a `category: "model"` select among
   *  its config options, which the host projects into this list. Drives the
   *  composer's model pill; empty when the agent advertises no such option. */
  available_models: SessionModeInfo[];
  available_commands: unknown[];
  /** Raw ACP config-option state — advertised config options and their current
   *  values, kept current by the `config_options_updated` delta. The composer
   *  renders these as generic knobs, minus the ones a dedicated picker owns. */
  config_options?: unknown[];
  /** Whether the agent's transport accepts image content blocks in prompts
   *  (`promptCapabilities.image`). Drives the composer's attach routing:
   *  true → picked/pasted images become inline base64 attachments; false →
   *  they degrade to path mention chips. */
  prompt_image_supported: boolean;
  plan: PlanEntry[];
  messages: SessionMessage[];
  usage: Usage;
  created_at: string;
  updated_at: string;
}

/**
 * Not a session delta: the manager's per-agent loading status (`Downloading
 * Node.js…`, `Installing @agentclientprotocol/codex-acp 1.11.0…`) while a
 * plugin's connect is in flight. Keyed by PLUGIN id because there is no
 * session — and no `agent_id` — until the connect finishes. `null` clears it.
 * Mirrors `AgentManagerEvent::LoadingStatusChanged` forwarded onto the
 * `atlas:agents` window event as `{kind: "loading_status", plugin_id, status}`.
 */
export interface LoadingStatusEvent {
  kind: "loading_status";
  plugin_id: string;
  status: string | null;
}

/**
 * Not a session delta: where an installed agent's update is. Keyed by plugin
 * id — an update belongs to the agent, not to one session. `waiting`: queued
 * behind a reply still running. `restarting`: the old process was dropped
 * once idle, and open chats reconnect on their next send. `installing`: the
 * new version is downloading. `ready`: it is installed. `failed`: the install
 * did not finish; the next connect retries it.
 */
export interface AgentUpdateEvent {
  kind: "agent_update";
  plugin_id: string;
  version: string;
  phase: "waiting" | "restarting" | "installing" | "ready" | "failed";
  error: string | null;
}

/** Everything the `atlas:agents` window event can carry. Session-scoped
 *  deltas, plus the session-less loading status and update events above. */
export type AgentStreamEvent = AgentDelta | LoadingStatusEvent | AgentUpdateEvent;

/**
 * Single multiplexed delta stream emitted on the `atlas:agents` window event.
 * `kind` discriminates; `agent_id` + `session_id` route to the right tab.
 */
export type AgentDelta =
  | {
      kind: "status";
      agent_id: AgentId;
      session_id: AcpSessionId;
      status: SessionStatus;
      turn_seq?: number;
    }
  | {
      kind: "message_appended";
      agent_id: AgentId;
      session_id: AcpSessionId;
      message: SessionMessage;
    }
  | {
      kind: "text_chunk";
      agent_id: AgentId;
      session_id: AcpSessionId;
      message_id: string;
      delta: string;
    }
  | {
      kind: "thinking_chunk";
      agent_id: AgentId;
      session_id: AcpSessionId;
      message_id: string;
      delta: string;
    }
  | {
      kind: "tool_call_upserted";
      agent_id: AgentId;
      session_id: AcpSessionId;
      message_id: string;
      tool_call: ToolCall;
    }
  | {
      // Incremental live command output — append `delta` to the tool call's
      // `result` (the streaming sibling of `tool_call_upserted`; full
      // snapshots would re-ship the whole accumulated output per chunk).
      kind: "tool_call_output_chunk";
      agent_id: AgentId;
      session_id: AcpSessionId;
      message_id: string;
      tool_call_id: string;
      delta: string;
    }
  | {
      kind: "plan_updated";
      agent_id: AgentId;
      session_id: AcpSessionId;
      plan: PlanEntry[];
    }
  | {
      kind: "history_rewound";
      agent_id: AgentId;
      session_id: AcpSessionId;
      /** Whole exchanges removed from the end, counted by user messages. */
      turns: number;
    }
  | {
      kind: "mode_changed";
      agent_id: AgentId;
      session_id: AcpSessionId;
      mode_id: string;
    }
  | {
      kind: "model_changed";
      agent_id: AgentId;
      session_id: AcpSessionId;
      model_id: string;
    }
  | {
      kind: "available_commands";
      agent_id: AgentId;
      session_id: AcpSessionId;
      commands: unknown[];
    }
  | {
      kind: "usage_updated";
      agent_id: AgentId;
      session_id: AcpSessionId;
      usage: Usage;
    }
  | {
      /** The agent is asking the user something mid-turn (P3.3). */
      kind: "elicitation_requested";
      agent_id: AgentId;
      session_id: AcpSessionId;
      request_id: string;
      mode: "form" | "url";
      message: string;
      requested_schema?: unknown;
      url?: string | null;
    }
  | {
      /** The agent named its own session (P3.1). Beats Atlas's
       *  first-40-characters-of-the-prompt title. */
      kind: "title_updated";
      agent_id: AgentId;
      session_id: AcpSessionId;
      title: string;
    }
  | {
      /** The agent's own config options changed (P2.2) — a knob toggled inside
       *  the agent rather than through Atlas. Raw JSON, same shape the snapshot
       *  carries. */
      kind: "config_options_updated";
      agent_id: AgentId;
      session_id: AcpSessionId;
      config_options: unknown[];
    }
  | {
      kind: "context_usage";
      agent_id: AgentId;
      session_id: AcpSessionId;
      used: number;
      size: number;
      cost: number;
      /** ISO 4217 code `cost` is in; null/absent means USD. */
      currency?: string | null;
    }
  | {
      kind: "compaction";
      agent_id: AgentId;
      session_id: AcpSessionId;
      active: boolean;
    }
  | {
      kind: "compression_saved";
      agent_id: AgentId;
      session_id: AcpSessionId;
      saved_tokens: number;
    }
  | {
      /** The account's quota windows (native engine only; account-level, so
       *  every live native session hears the same snapshot). */
      kind: "rate_limits";
      agent_id: AgentId;
      session_id: AcpSessionId;
      primary: RateLimitWindow | null;
      secondary: RateLimitWindow | null;
      plan_type: string | null;
    }
  | {
      kind: "permission_request";
      agent_id: AgentId;
      session_id: AcpSessionId;
      request_id: string;
      tool_call: unknown;
      options: unknown;
    }
  | {
      kind: "permission_resolved";
      agent_id: AgentId;
      session_id: AcpSessionId;
      request_id: string;
    }
  | {
      kind: "turn_finished";
      agent_id: AgentId;
      session_id: AcpSessionId;
      stop_reason: string;
      turn_seq?: number;
    }
  | {
      kind: "turn_failed";
      agent_id: AgentId;
      session_id: AcpSessionId;
      error: string;
      turn_seq?: number;
      error_kind?: "auth" | "transient" | "fatal" | "process_dead" | "unknown";
    }
  | {
      kind: "retry_status";
      agent_id: AgentId;
      session_id: AcpSessionId;
      attempt: number;
      max_attempts: number;
      delay_ms: number;
      last_error: string;
    }
  | {
      kind: "agent_disconnected";
      agent_id: AgentId;
      session_id: AcpSessionId;
      reason: string;
    }
  | {
      /** This turn is a Run in a Shared Thread (ATL-405). */
      kind: "shared_run_started";
      agent_id: AgentId;
      session_id: AcpSessionId;
      shared_thread_id: string;
      run_id: string;
      run_no: number;
    }
  | {
      /** The Run ended: merged into the thread, or not, and why. */
      kind: "shared_run_ended";
      agent_id: AgentId;
      session_id: AcpSessionId;
      shared_thread_id: string;
      run_id: string;
      status: string;
      files: string[];
      version: number | null;
      error: string | null;
    };
