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

export function getClaudeSessionStats(
  cwd: string,
  sessionId: string
): Promise<ClaudeSessionStats> {
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
