import type { ToolCallRef } from "@/types/acp";
import { formatTime } from "@/lib/format-time";

/** A saved plan record — mirrors `commands/plans.rs::PlanRecord`. */
export interface PlanRecord {
  id: string;
  sessionId: string | null;
  sessionTitle: string | null;
  userMessage: string;
  plan: string;
  timestamp: string;
}

/**
 * Pull the plan markdown out of a permission tool call. Claude Code's
 * ExitPlanMode tool carries `{ plan: "<markdown>" }` in its input; the ACP
 * bridge surfaces that under `rawInput` (or `input`). Returns the markdown
 * string when present and non-empty, else null.
 */
export function extractPlanMarkdown(tc: ToolCallRef): string | null {
  const record = tc as Record<string, unknown>;
  const input = (record.rawInput ?? record.input) as unknown;
  if (input && typeof input === "object") {
    const plan = (input as Record<string, unknown>).plan;
    if (typeof plan === "string" && plan.trim().length > 0) {
      return plan;
    }
  }
  return null;
}

/**
 * Human-friendly timestamp for a plan, e.g. "Jun 3, 2026 · 2:45 PM". Falls
 * back to the raw string if it isn't a valid date.
 */
export function formatPlanTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const time = formatTime(d);
  return `${date} · ${time}`;
}

/** Short relative age, e.g. "just now", "3m", "2h", "5d". */
export function planTimeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}
