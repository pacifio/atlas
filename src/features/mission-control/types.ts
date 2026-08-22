// Wire shapes from `commands/mission_control.rs::MissionControlUsage` (camelCase).

export interface ClaudeMetrics {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requests: number;
  costUsd: number;
  sessions: number;
}

export interface CodexMetrics {
  tokens: number;
  sessions: number;
}

export interface ProjectMetrics {
  projectPath: string;
  projectName: string;
  claude: ClaudeMetrics;
  codex: CodexMetrics;
  firstActivityMs: number | null;
  lastActivityMs: number | null;
  totalTokens: number;
}

export interface DailyBucket {
  date: string; // "YYYY-MM-DD"
  projectPath: string;
  claudeInput: number;
  claudeOutput: number;
  claudeCost: number;
  claudeRequests: number;
  codexTokens: number;
}

export interface ByokDay {
  date: string;
  input: number;
  output: number;
  cost: number;
}

export interface GrandTotals {
  claudeInput: number;
  claudeOutput: number;
  claudeCache: number;
  claudeCost: number;
  claudeRequests: number;
  claudeSessions: number;
  codexTokens: number;
  codexSessions: number;
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
