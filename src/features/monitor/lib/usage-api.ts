import { invoke } from "@tauri-apps/api/core";

/**
 * Agent usage, read from Atlas's own record rather than from any agent CLI's
 * private storage.
 *
 * The three usage surfaces — the status-bar widget, the usage panel and Mission
 * Control — used to parse Claude's `~/.claude/projects` JSONL and price it with
 * a table hardcoded in Rust, which made all three Claude-only by construction.
 * They now read what Atlas recorded for **every** agent, priced from the
 * models.dev map Atlas already caches (ADR-0001, issue #17).
 *
 * Two honest limits follow, and the UI says so where it shows them: only
 * sessions run through Atlas are counted, and a model missing from the price
 * map contributes tokens with no cost rather than a guess.
 */

/** One recorded session's usage. snake_case, like every session-shaped payload. */
export interface SessionUsage {
  /** The agent's own session id — the ACP session id. */
  session_id: string;
  /** Which agent ran it. Data, never a code path. */
  agent: string | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /**
   * Recorded messages — user and assistant rows in Atlas's own record. Not
   * "requests", which is what the JSONL scrape counted: Atlas has no idea how
   * many HTTP calls an agent made.
   */
  messages: number;
  /** `0` when the model is unknown or unpriced. Never a guess. */
  total_cost_usd: number;
  /** When the session started, epoch milliseconds. */
  started_ms: number;
  /** When the session last did work, epoch milliseconds. */
  last_activity_ms: number | null;
  title: string;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  messages: number;
  total_cost_usd: number;
  session_count: number;
}

export interface ProjectUsage {
  totals: UsageTotals;
  sessions: SessionUsage[];
}

/** Usage for every session Atlas recorded in `projectPath`, costliest first. */
export function getProjectUsage(projectPath: string): Promise<ProjectUsage> {
  return invoke<ProjectUsage>("agent_project_usage", { projectPath });
}

/**
 * Usage for one live session, keyed by the agent's own session id.
 *
 * `null` when Atlas never recorded that session — the widget then falls back to
 * its live per-turn counters instead of showing a confident zero.
 */
export function getSessionUsage(
  projectPath: string,
  sessionId: string,
): Promise<SessionUsage | null> {
  return invoke<SessionUsage | null>("agent_session_usage", { projectPath, sessionId });
}
