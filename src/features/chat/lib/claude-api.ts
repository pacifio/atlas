// Legacy Claude Code helpers. The interactive subprocess path (run / stream /
// stop / check / version) was replaced by the ACP integration in
// `lib/acp-api.ts`. What remains here reads existing JSONL session history
// from `~/.claude/projects/` — both the legacy CLI and the canonical ACP
// agent (`@agentclientprotocol/claude-agent-acp`, which uses the same Claude Agent
// SDK) write to that directory, so the history-browser surface still works
// against ACP-produced sessions.

import { invoke } from "@tauri-apps/api/core";

export interface ClaudeSessionMeta {
  id: string;
  file_path: string;
  started_at: string | null;
  last_modified: string | null;
  message_count: number;
  preview: string;
  /** Cumulative tokens processed across the session (native Atlas agent only;
   *  Claude/Codex disk rows omit it → undefined). */
  total_tokens?: number;
}

export interface ToolCallDump {
  tool_name: string;
  input: Record<string, unknown>;
}

export interface ChatMessageDump {
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  tool_calls: ToolCallDump[];
}

export function listClaudeSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>("list_claude_sessions", { cwd });
}

/**
 * Codex sessions for `cwd`, shaped like {@link ClaudeSessionMeta} so the
 * sidebar can merge both agents. `id` is the Codex thread id (the resume key
 * the codex-acp adapter accepts in `session/load`); `file_path` is always
 * empty since Codex has no single editable transcript file.
 */
export function listCodexSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>("list_codex_sessions", { cwd });
}

/**
 * Native Atlas (Cersei) agent sessions for `cwd`, shaped like
 * {@link ClaudeSessionMeta} (Rust `atlas_cersei::SessionMeta`) so the sidebar
 * merges all three agents. `id` is the resume key; `file_path` points at the
 * persisted JSON transcript under the app config dir.
 */
export function listCerseiSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>("cersei_list_sessions", { projectPath: cwd });
}

/**
 * Kilo Code sessions for `cwd`, shaped like {@link ClaudeSessionMeta}. Read
 * from Kilo's SQLite store (`~/.local/share/kilo/kilo.db`); `id` is the real
 * ACP session id (`ses_…`) so it resumes via `session/load` (full replay);
 * `file_path` is always empty (no per-session transcript file).
 */
export function listKiloSessions(cwd: string): Promise<ClaudeSessionMeta[]> {
  return invoke<ClaudeSessionMeta[]>("list_kilo_sessions", { projectPath: cwd });
}

/** One Atlas-recorded session row. Adds `plugin_id` to the shared meta shape,
 *  because unlike the per-agent listings above this one covers MANY agents and
 *  the row has to say which.
 *
 *  snake_case, like `ClaudeSessionMeta` and every other session payload — the
 *  sidebar reads `message_count` / `file_path` off these directly, and a
 *  camelCase mismatch is invisible to TypeScript but silently drops every row
 *  as "empty". */
export interface AtlasTranscriptMeta extends ClaudeSessionMeta {
  plugin_id: string;
}

/**
 * Session history for every agent that keeps no transcript of its own —
 * opencode, cursor, and all registry-installed agents.
 *
 * Those agents are `TranscriptKind::None`, so before Atlas recorded them itself
 * their sessions existed only in the renderer's memory: the history row
 * vanished as soon as the live session stopped matching (switching agents was
 * enough) and the conversation was gone. `file_path` points at Atlas's own JSON
 * under `<config>/agent-transcripts/`.
 */
export function listAtlasTranscripts(cwd: string): Promise<AtlasTranscriptMeta[]> {
  return invoke<AtlasTranscriptMeta[]>("agent_transcripts_list", { cwd });
}

/** One session an AGENT reports it has stored (P2.3, ACP `session/list`). */
export interface AgentSessionInfo {
  sessionId: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
}

/** Sessions the agent itself knows about, or `null` when it is not running or
 *  never advertised `sessionCapabilities.list`.
 *
 *  This is the listing that scales: every other source in the sidebar is a
 *  bespoke reader for one agent's storage format (Claude JSONL, Codex SQLite,
 *  Kilo SQLite, Cersei JSON), so an ACP agent Atlas has never heard of gets no
 *  history at all. Asking the agent works for any of them. */
export function listAgentSessions(
  pluginId: string,
  cwd: string,
): Promise<AgentSessionInfo[] | null> {
  return invoke<AgentSessionInfo[] | null>("agents_agent_sessions", { pluginId, cwd });
}

/** Ask the agent to forget one of its own sessions (P2.3, ACP
 *  `session/delete`). Resolves `false` when the agent is not running or has no
 *  such capability, so the caller can fall through rather than reporting a
 *  failure the user cannot act on. */
export function deleteAgentSession(pluginId: string, sessionId: string): Promise<boolean> {
  return invoke<boolean>("agents_delete_agent_session", { pluginId, sessionId });
}

/** Delete one Atlas-recorded transcript. Idempotent. */
export function atlasTranscriptDelete(cwd: string, sessionId: string): Promise<void> {
  return invoke<void>("agent_transcripts_delete", { cwd, sessionId });
}

/** Archive (soft-delete) a Kilo session — sets `time_archived`, the flag both
 *  Kilo's own UIs and our listing filter on. Reversible from the Kilo CLI. */
export function kiloDeleteSession(sessionId: string): Promise<void> {
  return invoke<void>("kilo_delete_session", { sessionId });
}

export function readClaudeSession(filePath: string): Promise<ChatMessageDump[]> {
  return invoke<ChatMessageDump[]>("read_claude_session", { filePath });
}

export function deleteClaudeSession(filePath: string): Promise<void> {
  return invoke<void>("delete_claude_session", { filePath });
}

/**
 * Delete a native Atlas (Cersei) session by id. Cersei transcripts live under
 * the app config dir (not `~/.claude/projects`), so they need their own command
 * — `delete_claude_session` rejects any path outside the Claude projects dir.
 */
export function cerseiDeleteSession(cwd: string, sessionId: string): Promise<void> {
  return invoke<void>("cersei_delete_session", { projectPath: cwd, sessionId });
}

/**
 * Archive (soft-delete) a Codex session by thread id. Codex keeps threads in
 * `~/.codex/state_<n>.sqlite` with no per-session file, so the backend sets
 * `archived = 1` (the flag the listing filters on) rather than removing a row.
 */
export function codexDeleteSession(sessionId: string): Promise<void> {
  return invoke<void>("codex_delete_session", { sessionId });
}

export interface ClaudeSessionStats {
  session_id: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  request_count: number;
  total_cost_usd: number;
}

export function getClaudeSessionStats(cwd: string, sessionId: string): Promise<ClaudeSessionStats> {
  return invoke<ClaudeSessionStats>("claude_session_stats", { cwd, sessionId });
}

export interface SessionUsage extends ClaudeSessionStats {
  /** File mtime in epoch milliseconds. */
  last_modified: number | null;
  preview: string;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  request_count: number;
  total_cost_usd: number;
  session_count: number;
}

export interface ProjectUsage {
  totals: UsageTotals;
  sessions: SessionUsage[];
}

/** Aggregate token/cost usage across all Claude Code sessions of `cwd`. */
export function getProjectUsage(cwd: string): Promise<ProjectUsage> {
  return invoke<ProjectUsage>("project_usage_stats", { cwd });
}
