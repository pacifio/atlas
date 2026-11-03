/**
 * The pure half of the Session reader (`session-detail.tsx`): how entries are
 * filtered, folded and grouped, and how the figures beside them are worded.
 *
 * No React and no IPC — the container and the views both read from here.
 */

import { formatTime } from "@/lib/format-time";
import { fmtCost } from "@/features/monitor/lib/usage-format";

import type { SessionDetail as Detail, TimelineEntry, TimelineFilters } from "../types";
import { formatDuration } from "./board";

/** Half the tallest rail node — where the hairline starts and stops. */
export const NODE_CENTRE = 16;

export interface Group {
  id: string;
  kind: TimelineEntry["kind"];
  entries: TimelineEntry[];
}

/**
 * Keep only the last response of each consecutive run.
 *
 * An agent narrates as it works — "let me check X", "now Y", then the actual
 * answer. Reading a finished Session, the narration is scaffolding and the last
 * message of a run is the conclusion. Folding to it turns a forty-message
 * transcript into the handful of statements that survived.
 *
 * Deliberately per *run*, not per turn: a run ends at the next prompt, tool call
 * or Checkpoint, so a response that comes after real work is kept even if
 * another response follows later. The alternative — one response per turn —
 * would silently drop the conclusion of every turn that ended in a commit.
 */
export function foldRuns(entries: TimelineEntry[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "response" && out[out.length - 1]?.kind === "response") {
      out[out.length - 1] = entry;
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Fold runs of consecutive tool calls into one group; everything else is its own. */
export function groupEntries(entries: TimelineEntry[]): Group[] {
  const out: Group[] = [];
  for (const entry of entries) {
    const tail = out[out.length - 1];
    if (entry.kind === "tool_call" && tail?.kind === "tool_call") {
      tail.entries.push(entry);
      continue;
    }
    out.push({ id: entry.id, kind: entry.kind, entries: [entry] });
  }
  return out;
}

export function kindLabel(group: Group): string {
  switch (group.kind) {
    case "prompt":
      return "Prompt";
    case "response":
      return "Response";
    case "thinking":
      return "Thinking";
    case "checkpoint":
      return "Checkpoint";
    case "tool_call":
      return group.entries.length === 1 ? (group.entries[0].toolName ?? "Tool call") : "Tool calls";
  }
}

/** Tools that change a file, versus tools that only look at one. */
const WRITERS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "str_replace_editor"]);
const READERS = new Set(["Read", "Grep", "Glob", "List", "LS", "Search"]);

export function summarise(calls: TimelineEntry[]): {
  parts: string[];
  added: number;
  removed: number;
} {
  const edited = new Set<string>();
  const read = new Set<string>();
  let added = 0;
  let removed = 0;

  for (const call of calls) {
    const name = call.toolName ?? "";
    const target = call.paths[0];
    if (WRITERS.has(name)) {
      if (target) edited.add(target);
      const delta = lineDelta(call.arguments);
      added += delta.added;
      removed += delta.removed;
    } else if (READERS.has(name) && target) {
      read.add(target);
    }
  }

  const parts: string[] = [];
  if (edited.size) parts.push(`${edited.size} modified`);
  if (read.size) parts.push(`${read.size} read`);
  return { parts, added, removed };
}

/**
 * Lines added and removed by one edit, from its arguments.
 *
 * `old_string` / `new_string` are the literal before and after, so their line
 * counts *are* the delta. A `Write` has only `content`, which is all addition.
 * Anything unparseable contributes nothing rather than a guess.
 */
function lineDelta(args: string | null): { added: number; removed: number } {
  if (!args) return { added: 0, removed: 0 };
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return { added: 0, removed: 0 };
  }
  const count = (v: unknown) => (typeof v === "string" ? v.split("\n").length : 0);

  let added = 0;
  let removed = 0;
  const visit = (node: Record<string, unknown>) => {
    added += count(node.new_string) + count(node.content);
    removed += count(node.old_string);
  };
  if (parsed && typeof parsed === "object") {
    const root = parsed as Record<string, unknown>;
    visit(root);
    // MultiEdit nests the real pairs one level down.
    if (Array.isArray(root.edits)) {
      for (const edit of root.edits) {
        if (edit && typeof edit === "object") visit(edit as Record<string, unknown>);
      }
    }
  }
  return { added, removed };
}

/**
 * Is this entry's payload actually spilled, or already inlined in full?
 *
 * A spilled-but-small payload is already inlined whole, so the ref alone is not
 * enough — a full inline is ~64 KB where a preview is ~2 KB.
 */
export function spilledRef(ref: string | null, inline: string | null): string | null {
  if (!ref) return null;
  return (inline?.length ?? 0) <= 4096 ? ref : null;
}

/** Which half of an entry to fetch. Mirrors the server's `part` parameter. */
export type PayloadPart = "body" | "arguments" | "result";

/**
 * `$4.12`, or `<$0.01`.
 *
 * Two decimals is the unit people think in, but a short Session can genuinely
 * cost a fraction of a cent and rendering that as `$0.00` reads as "free"
 * rather than "very cheap".
 */
export function costLabel(cost: number): string {
  return cost >= 0.01 ? fmtCost(cost) : `<${fmtCost(0.01)}`;
}

export function passes(
  entry: TimelineEntry,
  filters: TimelineFilters,
  failedOnly: boolean,
  tools: Set<string>,
): boolean {
  switch (entry.kind) {
    case "prompt":
      return filters.prompts;
    case "response":
      return filters.responses;
    case "thinking":
      return filters.thinking;
    case "checkpoint":
      return filters.checkpoints;
    case "tool_call":
      if (!filters.toolCalls) return false;
      if (failedOnly && entry.toolStatus !== "failed") return false;
      if (tools.size > 0 && !tools.has(entry.toolName ?? "Other")) return false;
      return true;
  }
}

/**
 * Free-text search over one entry.
 *
 * The haystack — every searchable field lowercased and joined — is built ONCE
 * per entry and cached in a WeakMap. Building it per keystroke was the cost
 * that made search feel heavy: `arguments` and `result` previews run to 64 KB,
 * a Session runs to hundreds of entries, and `toLowerCase()` over all of it
 * allocated megabytes of transient strings for every character typed. The
 * entry-sharing pass above is what makes the WeakMap effective across live
 * polls: a reused entry object keeps its haystack.
 *
 * Fields are joined with `\n`, which a single-line search input can never
 * contain, so a needle cannot falsely match across a field boundary. Payloads
 * are searched too — a stack trace is exactly the thing someone comes back to
 * a Session to find — but a truncated entry can only match on its preview,
 * which is stated on the row rather than silently missed.
 */
const haystacks = new WeakMap<TimelineEntry, string>();

function haystack(entry: TimelineEntry): string {
  let built = haystacks.get(entry);
  if (built === undefined) {
    built = [
      entry.text,
      entry.toolName,
      entry.toolTitle,
      entry.commitSubject,
      entry.commitSha,
      entry.branch,
      entry.arguments,
      entry.result,
      ...entry.paths,
      ...entry.files,
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    haystacks.set(entry, built);
  }
  return built;
}

export function matches(entry: TimelineEntry, needle: string): boolean {
  if (!needle) return true;
  return haystack(entry).includes(needle);
}

/**
 * `18:29 → 19:27 · 2h 14m span`, under the active-time metric.
 *
 * Both numbers, because they answer different questions: the metric is agent
 * time and this is the wall-clock span it happened inside. Showing only one
 * invites reading it as the other.
 */
export function clock(s: Detail["summary"]): string {
  const fmt = (iso: string) => formatTime(iso, { hour: "2-digit", minute: "2-digit" });
  return `${fmt(s.startedAt)} → ${fmt(s.lastActivityAt)} · ${formatDuration(s.wallSeconds)} span`;
}

export function time(iso: string): string {
  return formatTime(iso, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
