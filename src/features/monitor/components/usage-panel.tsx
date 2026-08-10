import { useEffect, useState } from "react";
import { Maximize2 } from "lucide-react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useUsageReport } from "../stores/usage-report-store";
import type { SessionUsage } from "@/features/chat/lib/claude-api";
import { UsageDonut, type DonutSegment } from "./usage-donut";
import { UsageModal } from "./usage-modal";
import { fmtTokens, fmtCost } from "../lib/usage-format";

// White-opacity ladder for the top sessions; dim "others" bucket.
const SESSION_COLORS = [
  "rgba(255,255,255,0.92)",
  "rgba(255,255,255,0.70)",
  "rgba(255,255,255,0.52)",
  "rgba(255,255,255,0.38)",
  "rgba(255,255,255,0.26)",
];
const OTHERS_COLOR = "var(--text-ghost)";

const TOKEN_TYPES = [
  { key: "input_tokens", label: "Input", color: "var(--text-primary)" },
  { key: "output_tokens", label: "Output", color: "var(--text-secondary)" },
  { key: "cache_creation_tokens", label: "Cache write", color: "var(--status-info)" },
  { key: "cache_read_tokens", label: "Cache read", color: "var(--text-tertiary)" },
] as const;

const sessionTokens = (s: SessionUsage) =>
  s.input_tokens + s.output_tokens + s.cache_creation_tokens + s.cache_read_tokens;

export function UsagePanel() {
  const cwd = useProjectStore((s) => s.currentProject?.path ?? null);
  const data = useUsageReport((s) => (cwd ? s.byCwd[cwd] : undefined));
  const loading = useUsageReport((s) => s.loadingCwd === cwd);
  const load = useUsageReport((s) => s.load);
  const [modalOpen, setModalOpen] = useState(false);

  // Revalidate on mount/cwd change (cached value shows instantly meanwhile).
  useEffect(() => {
    if (cwd) void load(cwd);
  }, [cwd, load]);

  if (!data) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-text-tertiary">
        {loading ? "Loading usage…" : "No agent usage recorded yet."}
      </div>
    );
  }
  if (data.totals.session_count === 0) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-text-tertiary">
        No agent usage recorded for this project yet.
      </div>
    );
  }

  const { totals, sessions } = data;
  const useCost = totals.total_cost_usd > 0;
  const metric = (s: SessionUsage) => (useCost ? s.total_cost_usd : sessionTokens(s));

  // Donut: top 5 sessions + "others".
  const top = sessions.slice(0, 5);
  const restMetric = sessions.slice(5).reduce((sum, x) => sum + metric(x), 0);
  const segments: DonutSegment[] = top.map((s, i) => ({
    label: s.session_id,
    value: metric(s),
    color: SESSION_COLORS[i] ?? OTHERS_COLOR,
  }));
  if (restMetric > 0) segments.push({ label: "others", value: restMetric, color: OTHERS_COLOR });

  const totalTokens =
    totals.input_tokens +
    totals.output_tokens +
    totals.cache_creation_tokens +
    totals.cache_read_tokens;

  return (
    <div className="h-full overflow-y-auto hide-scrollbar px-3 py-3 space-y-4">
      {/* Donut — full width, total cost in the center. */}
      <div className="flex justify-center">
        <UsageDonut segments={segments} size={148} thickness={16}>
          <span className="text-[15px] font-semibold text-text-primary leading-none">
            {fmtCost(totals.total_cost_usd)}
          </span>
          <span className="text-[8px] text-text-tertiary uppercase tracking-wider mt-1">
            total cost
          </span>
        </UsageDonut>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Tokens" value={fmtTokens(totalTokens)} />
        <Stat label="Requests" value={totals.request_count.toLocaleString()} />
        <Stat label="Sessions" value={String(totals.session_count)} />
      </div>

      {/* Token-type breakdown */}
      <div className="space-y-1.5">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-[var(--border-default)]">
          {TOKEN_TYPES.map((t) => {
            const pct = totalTokens > 0 ? (totals[t.key] / totalTokens) * 100 : 0;
            return pct > 0 ? (
              <div key={t.key} style={{ width: `${pct}%`, background: t.color }} />
            ) : null;
          })}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {TOKEN_TYPES.map((t) => (
            <div key={t.key} className="flex items-center gap-1.5 min-w-0">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: t.color }} />
              <span className="text-[10px] text-text-tertiary truncate flex-1 min-w-0">
                {t.label}
              </span>
              <span className="text-[10px] font-mono tabular-nums text-text-secondary shrink-0">
                {fmtTokens(totals[t.key])}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Per-session table (top 5) + expand */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-semibold text-text-tertiary uppercase tracking-wider">
            By session
          </span>
          {sessions.length > 5 && (
            <button
              onClick={() => setModalOpen(true)}
              className="flex items-center gap-1 text-[10px] text-text-tertiary hover:text-text-primary transition-colors"
              title="View all sessions"
            >
              <Maximize2 size={10} /> All {sessions.length}
            </button>
          )}
        </div>
        <div className="rounded-md border border-border-default overflow-hidden">
          {top.map((s, i) => (
            <div
              key={s.session_id}
              className="flex items-center gap-2 px-2 h-[26px] border-b border-border-subtle last:border-b-0"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: SESSION_COLORS[i] ?? OTHERS_COLOR }}
              />
              <span className="text-[10px] text-text-secondary truncate flex-1 min-w-0">
                {s.preview || s.session_id.slice(0, 8)}
              </span>
              <span className="text-[9px] font-mono tabular-nums text-text-tertiary shrink-0 w-10 text-right">
                {fmtTokens(sessionTokens(s))}
              </span>
              <span className="text-[10px] font-mono tabular-nums text-text-secondary shrink-0 w-14 text-right">
                {fmtCost(s.total_cost_usd)}
              </span>
            </div>
          ))}
        </div>
      </div>

      <UsageModal open={modalOpen} onOpenChange={setModalOpen} data={data} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-default bg-bg-secondary px-2 py-1.5 flex flex-col gap-0.5 min-w-0">
      <span className="text-[9px] text-text-tertiary uppercase tracking-wider truncate">
        {label}
      </span>
      <span className="text-[12px] font-mono tabular-nums text-text-primary truncate">{value}</span>
    </div>
  );
}
