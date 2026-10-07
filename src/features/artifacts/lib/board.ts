/**
 * Everything the Timeline derives from a board row, in one place.
 *
 * The sidebar, the stats strip and the weekly chart all read the same
 * `BoardSession[]`, and each one needs the same handful of facts about it — what
 * state a session is in, how long it ran, how many tokens it burned, which day
 * it belongs to. Deriving that three times is how the views drift apart.
 *
 * Formatting lives here too, deliberately: the design specifies `1h 04m` and
 * `212.8K`, and those exact shapes are load-bearing for the fixed-width columns
 * they sit in.
 */

import { stripInjectedContext } from "@/features/chat/lib/atlas-context";
import { agentMeta } from "@/features/agents/lib/agent-meta";

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
  // Imported before live: an import writes the row *now*, so a transcript read
  // seconds ago passes the liveness test while being months old. A corpus
  // re-import would otherwise turn the entire board green at once.
  if (session.source === "external_jsonl") return "imported";
  if (now - new Date(session.updatedAt).getTime() < LIVE_WINDOW_MS) return "live";
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
  if (session.contextUsed != null) {
    const size = session.contextSize ? ` / ${formatTokens(session.contextSize)}` : "";
    return `${formatTokens(session.contextUsed)}${size} ctx`;
  }
  // A Session that only ever read cache still spent something, and saying
  // nothing at all reads as "no data" rather than "no fresh tokens".
  const cached = session.cacheReadTokens + session.cacheCreationTokens;
  return cached > 0 ? `${formatTokens(cached)} cached` : null;
}

/** `1.2M in · 84.0K out · 900.1K cache read` — the full spend, for a tooltip. */
export function tokenBreakdown(session: SessionSummary): string | null {
  const parts: string[] = [];
  if (session.totalTokens > 0) parts.push(`${formatTokens(session.totalTokens)} in + out`);
  if (session.cacheCreationTokens > 0) {
    parts.push(`${formatTokens(session.cacheCreationTokens)} cache write`);
  }
  if (session.cacheReadTokens > 0) {
    parts.push(`${formatTokens(session.cacheReadTokens)} cache read`);
  }
  if (session.contextUsed != null) parts.push(`${formatTokens(session.contextUsed)} context`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * `84.2K`, `1.24M`, `1.55B` — the design's token shorthand.
 *
 * The billions tier is not theoretical: every request re-reads the cached
 * prefix, so a few months of sessions on this project report 1.5B cache-read
 * tokens. Without it that renders as `1548.47M`, which is both wider than the
 * column and harder to read than the number it stands for.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * `47m`, `1h 04m`, `142h`, `58d` — zero-padded minutes so the column stays
 * aligned, and **bounded** so no value can escape the cell that holds it.
 *
 * The stat tiles are a fifth of the panel each and render this at 28px. An
 * unbounded `1234h 56m` overflowed its tile and painted across the one beside
 * it. Minutes stop earning their space long before then: nobody reads the `06m`
 * in `42488h 06m`, and an org-wide total is legitimately in the thousands of
 * hours even once the underlying figure is honest.
 */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(0, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 100) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  if (hours < 1000) return `${hours}h`;
  return `${Math.round(hours / 24).toLocaleString()}d`;
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
    // Ids spell the minor version with a hyphen as often as a dot —
    // `claude-sonnet-4-6` is Sonnet 4.6, not Sonnet 4. The minor part is one
    // or two digits so a date suffix (`claude-opus-4-20250514`) is never read
    // as one.
    const match = raw.match(/(\d+)(?:[.-](\d{1,2}))?(?!\d)/);
    if (!match) return family;
    return `${family} ${match[2] ? `${match[1]}.${match[2]}` : match[1]}`;
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
 *
 * Agent markup is stripped here too. Capture now derives past it
 * (`crates/atlas-checkpoint/src/title.rs`), but titles stored before that fix
 * are the first line verbatim — `<pasted_content id="8a17">` — and a title is
 * set once and never re-derived, so this is what makes those read properly.
 */
export function sessionTitle(title: string | null): string | null {
  if (!title) return null;
  const clean = stripAgentMarkup(stripInjectedContext(title)).trim();
  return clean.length > 0 ? clean : null;
}

/** Wrappers whose whole block is agent machinery, dropped with its content. */
const DROPPED_BLOCK =
  /<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|command-message|bash-stdout|bash-stderr|task-notification|ide_opened_file|ide_selection)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/g;
/** Wrapper tags around content that is still the person's: the tag goes, the text stays. */
const WRAPPER_TAG = /<\/?(pasted_content|command-name|command-args|bash-input|user_query)\b[^>]*>/g;
/** `[Image #1]`, `[Pasted text #2 +40 lines]`. */
const ATTACHMENT_PLACEHOLDER = /\[(Image|Pasted text) #[^\]]*\]/g;
/** A title that is one tag and nothing else — an agent wrapper we don't know by name. */
const LONE_TAG = /^<\/?[A-Za-z][\w:-]*(\s[^<>]*)?\/?>$/;

/**
 * A stored title with agent wrapper markup taken out, mirroring the capture
 * side's derivation for the one line a stored title is. A title that was only
 * a paste opener reads as `Pasted text`, the same label capture now gives a
 * paste-only prompt; any other lone tag is no title at all.
 */
export function stripAgentMarkup(title: string): string {
  const trimmed = title.trim();
  if (LONE_TAG.test(trimmed)) {
    return /^<\/?pasted_content\b/.test(trimmed) ? "Pasted text" : "";
  }
  const stripped = trimmed
    .replace(DROPPED_BLOCK, " ")
    .replace(WRAPPER_TAG, " ")
    .replace(ATTACHMENT_PLACEHOLDER, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped.length > 0) return stripped;
  if (/\[Pasted text #|<pasted_content\b/.test(trimmed)) return "Pasted text";
  if (/\[Image #/.test(trimmed)) return "Image";
  return "";
}

/** The agent's display name, from the plugin id the wire carries. */
export function agentLabel(agent: string): string {
  if (agent.includes("claude")) return "Claude Code";
  if (agent.includes("codex")) return "Codex";
  if (agent.includes("opencode")) return "OpenCode";
  if (agent.includes("cursor")) return "Cursor";
  if (agent.includes("kilo")) return "Kilo";
  if (agent.includes("atlas-agent")) return "Atlas";
  // Registry-installed external agent: resolve its marketplace name (falls
  // back to a prettified id for purged metadata).
  return agentMeta(agent).label;
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

/** Local Monday midnight of the week `d` falls in. */
export function startOfWeek(d: Date): number {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // `getDay()` is Sunday-first; shift so a week runs Monday → Sunday, which is
  // how a working week reads on a board about work.
  const offset = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - offset);
  return day.getTime();
}

/** Local midnight on the first of the month `d` falls in. */
export function startOfMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** How coarsely the nav groups its rows. */
export type GroupPeriod = "day" | "week" | "month";

const START_OF: Record<GroupPeriod, (d: Date) => number> = {
  day: startOfDay,
  week: startOfWeek,
  month: startOfMonth,
};

/** `This week` / `Last week` / `Week of 27 Jul`. */
function weekLabel(date: Date): string {
  const weeks = Math.round((startOfWeek(new Date()) - startOfWeek(date)) / (7 * 86_400_000));
  if (weeks === 0) return "This week";
  if (weeks === 1) return "Last week";
  return `Week of ${shortDate(date)}`;
}

/** `This month` / `Last month` / `July` / `July 2025`. */
function monthLabel(date: Date): string {
  const now = new Date();
  const months = (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());
  if (months === 0) return "This month";
  if (months === 1) return "Last month";
  return date.toLocaleDateString(undefined, {
    month: "long",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

const LABEL_OF: Record<GroupPeriod, (d: Date) => string> = {
  day: dayLabel,
  week: weekLabel,
  month: monthLabel,
};

/**
 * Sessions grouped by the local period they were last **active** in.
 *
 * That key is `lastActivityAt`, never `updatedAt`. `updatedAt` moves whenever
 * the row is rewritten, so a bulk import of a year of transcripts filed all of
 * them under Today — 106 sessions, in the report that prompted this.
 */
export function bucketBy(
  sessions: BoardSession[],
  period: GroupPeriod,
): Map<number, BoardSession[]> {
  const startOf = START_OF[period];
  const buckets = new Map<number, BoardSession[]>();
  for (const session of sessions) {
    const key = startOf(new Date(session.lastActivityAt));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(session);
    else buckets.set(key, [session]);
  }
  return buckets;
}

/** {@link bucketBy} at the day grain. */
export function bucketByDay(sessions: BoardSession[]): Map<number, BoardSession[]> {
  return bucketBy(sessions, "day");
}

interface PeriodBucket {
  label: string;
  date: string;
  sessions: BoardSession[];
  /** `4 sessions · 2h 11m · 486.3K tok` */
  meta: string;
}

/**
 * Group into buckets, newest first.
 *
 * The input is already newest-first from the store, so insertion order into the
 * Map preserves the grouping and no second sort is needed.
 */
export function groupSessions(
  sessions: BoardSession[],
  period: GroupPeriod = "day",
): PeriodBucket[] {
  const label = LABEL_OF[period];
  return [...bucketBy(sessions, period).entries()].map(([key, rows]) => ({
    label: label(new Date(key)),
    date: shortDate(new Date(key)),
    sessions: rows,
    meta: totals(rows),
  }));
}

/** `4 sessions · 2h 11m · 486.3K tok` — the right-hand side of a day header. */
function totals(rows: BoardSession[]): string {
  const seconds = rows.reduce((a, s) => a + s.activeSeconds, 0);
  const tokens = rows.reduce((a, s) => a + s.totalTokens, 0);
  return [
    `${rows.length} session${rows.length === 1 ? "" : "s"}`,
    formatDuration(seconds),
    tokens > 0 ? `${formatTokens(tokens)} tok` : null,
  ]
    .filter(Boolean)
    .join(" · ");
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
