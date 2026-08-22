import { fmtTokens, fmtCost } from "@/features/monitor/lib/usage-format";
import { AGENT_COLOR } from "../../lib/chart-theme";
import type { MissionControlUsage } from "../../types";
import { StatCard } from "./stat-card";

/** The headline metric tiles — lifetime totals across all projects. */
export function StatCards({ data }: { data: MissionControlUsage }) {
  const t = data.totals;
  const totalIn = t.claudeInput;
  const totalOut = t.claudeOutput;
  const byokSince = data.byokSince ? new Date(data.byokSince).toLocaleDateString() : null;

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
      <StatCard
        label="Total Tokens"
        value={fmtTokens(t.totalTokens)}
        sub={`${fmtTokens(totalIn)} in · ${fmtTokens(totalOut)} out`}
        accent={AGENT_COLOR.claude}
      />
      <StatCard
        label="Total Cost"
        value={fmtCost(t.totalCostUsd)}
        sub="Claude + BYOK"
        accent={AGENT_COLOR.output}
      />
      <StatCard
        label="Requests"
        value={fmtTokens(t.claudeRequests)}
        sub={`${t.claudeSessions} sessions`}
      />
      <StatCard label="Cache Tokens" value={fmtTokens(t.claudeCache)} sub="creation + read" />
      <StatCard
        label="Codex"
        value={fmtTokens(t.codexTokens)}
        sub={`${t.codexSessions} threads · total only`}
        accent={AGENT_COLOR.codex}
      />
      <StatCard
        label="BYOK"
        value={fmtTokens(t.byokInput + t.byokOutput)}
        sub={byokSince ? `${t.byokRequests} calls · since ${byokSince}` : `${t.byokRequests} calls`}
        accent={AGENT_COLOR.byok}
      />
      <StatCard label="Projects" value={String(data.projects.length)} sub="tracked" />
    </div>
  );
}
