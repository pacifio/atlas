/**
 * Everything the Timeline derives from a board row, in one place.
 *
 * The list, the stats strip, the weekly chart and the calendar all read the same
 * `BoardSession[]`, and each one needs the same handful of facts about it — what
 * state a session is in, how long it ran, how many tokens it burned, which day
 * it belongs to. Deriving that four times is how the four views drift apart.
 *
 * Formatting lives here too, deliberately: the design specifies `1h 04m` and
 * `212.8K`, and those exact shapes are load-bearing for the fixed-width columns
 * they sit in.
 */

import { stripInjectedContext } from "@/features/chat/lib/atlas-context";

import type { BoardSession, SessionSummary } from "../types";

/**
 * How recently a session must have been written to count as still recording.
 *
 * The board has no explicit liveness flag, so this is inferred — but not
 * loosely. The panel re-reads every 15 s, so a row whose `updatedAt` is inside
 * this window was written to **since the last read**, which is real evidence of
 * an agent working rather than a guess from a vaguely recent timestamp. The
 * window is six polls wide to absorb clock skew between the store's clock and
 * this one; anything older goes back to its settled state on the next read.
 */
const LIVE_WINDOW_MS = 90_000;

/**
 * What a session's node says at a glance.
 *
 * Order matters: a session that needs attention says so even while it is still
 * being written, because a hole in the record is the more urgent fact.
 */
export type SessionState = "attention" | "live" | "imported" | "done";

export function sessionState(session: SessionSummary, now = Date.now()): SessionState {
  if (session.needsAttention) return "attention";
  if (now - new Date(session.updatedAt).getTime() < LIVE_WINDOW_MS) return "live";
  if (session.source === "external_jsonl") return "imported";
  return "done";
}

/**
 * What a row can honestly say about token use.
 *
 * The native agent reports a real input/output split; ACP agents (Claude Code,
 * Codex) report only context-window occupancy. Rendering the second as though
 * it were the first would inflate every ACP row and go *down* after a
 * compaction, so the two read differently: `212.8K tok` for a real total,
 * `853.1K / 1.0M ctx` for a gauge.
 */
export function tokenLabel(session: SessionSummary): string | null {
  if (session.totalTokens > 0) return `${formatTokens(session.totalTokens)} tok`;
  if (session.contextUsed == null) return null;
  const size = session.contextSize ? ` / ${formatTokens(session.contextSize)}` : "";
  return `${formatTokens(session.contextUsed)}${size} ctx`;
}

/** `84.2K`, `1.24M` — the design's token shorthand. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** `47m`, `1h 04m` — zero-padded minutes so the column stays aligned. */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * Turn a raw model id into the name a person says.
 *
 * The wire carries ids like `claude-fable-5[1m]` or `gpt-5.5-codex`; the
 * reference surfaces show "Fable 5" and "GPT-5.5". Derived, best-effort, and
 * falling back to the raw id — a name we cannot prettify is still a name.
 */
export function prettyModel(model: string | null): string | null {
  if (!model) return null;
  const raw = model.replace(/\[.*?\]/g, "").trim();
  const m = raw.toLowerCase();
  const versioned = (family: string) => {
    const version = raw.match(/(\d+(?:\.\d+)?)/)?.[1];
    return version ? `${family} ${version}` : family;
  };
  if (m.includes("fable")) return versioned("Fable");
  if (m.includes("opus")) return versioned("Opus");
  if (m.includes("sonnet")) return versioned("Sonnet");
  if (m.includes("haiku")) return versioned("Haiku");
  if (m.startsWith("gpt")) return raw.toUpperCase().replace("-CODEX", " Codex");
  return raw;
}

/**
 * A Session's title, as it should be read.
 *
 * Titles are derived at capture time from the first prompt — and Atlas injects
 * its own memory blocks into that prompt before the agent ever sees it, so a
 * Session whose first turn carried context is titled `RELEVANT PROJECT MEMORY
 * ---`. Stripping here rather than at each display site keeps the board, the
 * detail and the chat from disagreeing about what a Session is called.
 *
 * A title that is *only* injected context strips to nothing, which is a truthful
 * `null` — the Session genuinely has no title of its own.
 */
export function sessionTitle(title: string | null): string | null {
  if (!title) return null;
  const clean = stripInjectedContext(title).trim();
  return clean.length > 0 ? clean : null;
}

/** The agent's display name, from the plugin id the wire carries. */
export function agentLabel(agent: string): string {
  if (agent.includes("claude")) return "Claude Code";
  if (agent.includes("codex")) return "Codex";
  if (agent.includes("opencode")) return "OpenCode";
  if (agent.includes("cursor")) return "Cursor";
  if (agent.includes("kilo")) return "Kilo";
  if (agent.includes("cersei")) return "Atlas";
  return agent;
}

/** Local midnight, the key every day bucket is grouped on. */
export function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** `Today` / `Yesterday` / `Monday 27 Jul`. */
function dayLabel(date: Date): string {
  const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    // The year only earns its space once it is ambiguous.
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/** `Jul 29` — the muted date beside a day label. */
function shortDate(date: Date): string {
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/**
 * Sessions grouped by the local day they were last written to.
 *
 * The board, the weekly chart and the calendar all need this and each built its
 * own copy of the loop; the calendar's keyed on a different field for a while
 * before anyone noticed. One function, one key.
 */
export function bucketByDay(sessions: BoardSession[]): Map<number, BoardSession[]> {
  const byDay = new Map<number, BoardSession[]>();
  for (const session of sessions) {
    const key = startOfDay(new Date(session.updatedAt));
    const bucket = byDay.get(key);
    if (bucket) bucket.push(session);
    else byDay.set(key, [session]);
  }
  return byDay;
}

interface DayBucket {
  label: string;
  date: string;
  sessions: BoardSession[];
  /** `4 sessions · 2h 11m · 486.3K tok` */
  meta: string;
}

/**
 * Group into day buckets, newest first.
 *
 * The input is already newest-first from the store, so insertion order into the
 * Map preserves the grouping and no second sort is needed.
 */
export function groupByDay(sessions: BoardSession[]): DayBucket[] {
  return [...bucketByDay(sessions).entries()].map(([key, rows]) => ({
    label: dayLabel(new Date(key)),
    date: shortDate(new Date(key)),
    sessions: rows,
    meta: totals(rows),
  }));
}

/** `4 sessions · 2h 11m · 486.3K tok` — the right-hand side of a day header. */
function totals(rows: BoardSession[]): string {
  const seconds = rows.reduce((a, s) => a + s.durationSeconds, 0);
  const tokens = rows.reduce((a, s) => a + s.totalTokens, 0);
  return [
    `${rows.length} session${rows.length === 1 ? "" : "s"}`,
    formatDuration(seconds),
    tokens > 0 ? `${formatTokens(tokens)} tok` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** One bar of the weekly-activity chart. */
interface WeekDay {
  /** Local midnight. */
  key: number;
  minutes: number;
  /** `Jul 27` — the week-range endpoints. */
  label: string;
  /** `Wed Jul 29` — the hovered day, which needs the weekday to be readable. */
  full: string;
}

/** The last seven days, oldest first, ending today. */
export function lastSevenDays(sessions: BoardSession[]): WeekDay[] {
  const today = startOfDay(new Date());
  const byDay = bucketByDay(sessions);
  return Array.from({ length: 7 }, (_, i) => {
    const key = today - (6 - i) * 86_400_000;
    const date = new Date(key);
    const rows = byDay.get(key) ?? [];
    return {
      key,
      minutes: Math.round(rows.reduce((a, s) => a + s.durationSeconds, 0) / 60),
      label: shortDate(date),
      full: date.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
    };
  });
}

/** Which facet a filter option belongs to. */
export type FacetKey = "project" | "agent" | "model" | "branch";

interface FacetOption {
  /** The stored value — `null` is "all". */
  value: string | null;
  label: string;
  count: number;
}

export interface Facet {
  key: FacetKey;
  label: string;
  options: FacetOption[];
}

/** Every filter option the current board offers, with its row count. */
export function facets(sessions: BoardSession[]): Facet[] {
  const collect = (
    key: FacetKey,
    label: string,
    allLabel: string,
    pick: (s: BoardSession) => string[],
    display: (v: string) => string,
  ): Facet => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      for (const v of pick(s)) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return {
      key,
      label,
      options: [
        { value: null, label: allLabel, count: sessions.length },
        ...[...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([value, count]) => ({ value, label: display(value), count })),
      ],
    };
  };

  return [
    collect(
      "project",
      "Project",
      "All projects",
      (s) => [s.projectPath],
      (v) => v.split("/").pop() ?? v,
    ),
    collect("agent", "Agent", "All agents", (s) => (s.agent ? [s.agent] : []), agentLabel),
    collect(
      "model",
      "Model",
      "All models",
      (s) => (s.model ? [s.model] : []),
      (v) => prettyModel(v) ?? v,
    ),
    // A session can touch several branches, so it counts once per branch —
    // which is why these counts can exceed the session total.
    collect(
      "branch",
      "Branch",
      "All branches",
      (s) => s.branches,
      (v) => v,
    ),
  ].filter((f) => f.options.length > 1);
}

/** The active selection, one value per facet. `null` means unfiltered. */
export type FacetSelection = Record<FacetKey, string | null>;

export const NO_FACETS: FacetSelection = {
  project: null,
  agent: null,
  model: null,
  branch: null,
};

export function facetMatches(session: BoardSession, selection: FacetSelection): boolean {
  if (selection.project && session.projectPath !== selection.project) return false;
  if (selection.agent && session.agent !== selection.agent) return false;
  if (selection.model && session.model !== selection.model) return false;
  if (selection.branch && !session.branches.includes(selection.branch)) return false;
  return true;
}

/** How many facets are narrowing the board — the badge on the filter button. */
export function activeFacetCount(selection: FacetSelection): number {
  return Object.values(selection).filter(Boolean).length;
}
