// Wire shapes from `commands/mission_control.rs::MissionControlUsage` (camelCase).

/**
 * What Atlas's agents cost in one project — every agent, folded together.
 *
 * One bucket rather than one per agent: which agent ran a session is data on
 * the session, so a dashboard column per agent would need Atlas code for each
 * new one (ADR-0001, issue #17). Was `claude` + `codex`.
 */
export interface AgentMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Recorded messages — user and assistant rows in Atlas's own record. */
  messages: number;
  costUsd: number;
  sessions: number;
}

export interface ProjectMetrics {
  projectPath: string;
  projectName: string;
  agents: AgentMetrics;
  firstActivityMs: number | null;
  lastActivityMs: number | null;
  totalTokens: number;
}

export interface DailyBucket {
  date: string; // "YYYY-MM-DD"
  projectPath: string;
  agentInput: number;
  agentOutput: number;
  agentCost: number;
  agentMessages: number;
}

export interface ByokDay {
  date: string;
  input: number;
  output: number;
  cost: number;
}

export interface GrandTotals {
  agentInput: number;
  agentOutput: number;
  agentCache: number;
  agentCost: number;
  agentMessages: number;
  agentSessions: number;
  byokInput: number;
  byokOutput: number;
  byokCost: number;
  byokRequests: number;
  totalTokens: number;
  totalCostUsd: number;
}

export interface MissionControlUsage {
  projects: ProjectMetrics[];
  daily: DailyBucket[];
  byokDaily: ByokDay[];
  totals: GrandTotals;
  byokSince: string | null;
  generatedAt: string;
}

export type TimeRange = "7d" | "30d" | "90d" | "all";

export const RANGE_DAYS: Record<TimeRange, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};
