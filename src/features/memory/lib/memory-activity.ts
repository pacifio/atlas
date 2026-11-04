// Pure shaping for the Activity tab: the shared event log read as a history,
// newest first. Consecutive events from one session become one group (a
// session is the unit a person remembers: "the one where Claude fixed the
// retries"), and groups fall under day headings. Session start and end
// events bracket a group; they carry no memory of their own and are not
// listed.

import type { EntryKind, EventKind, MemoryEntry, MemoryEvent } from "./shared-memory-api";
import { str } from "./shared-memory-format";

export interface ActivityLine {
  seq: number;
  kind: EventKind;
  /** What the agent did, as a verb phrase ("decided", "finished the plan"). */
  verb: string;
  /** The memory the event recorded, or the change it summarises. */
  text: string;
  /** A file change's path. */
  path: string | null;
  /** The record entry this event became, when it still stands. */
  entryId: number | null;
}

export interface ActivityGroup {
  key: string;
  agent: string;
  sessionId: string;
  /** The group's newest event. */
  end: number;
  lines: ActivityLine[];
}

export interface ActivityDay {
  key: string;
  label: string;
  groups: ActivityGroup[];
}

/** Events that mark a session's edges, not a memory. */
const BRACKETS: ReadonlySet<string> = new Set(["session_start", "session_end"]);

/** The record kind an event kind is written as. */
const ENTRY_KIND: Partial<Record<EventKind, EntryKind>> = {
  plan_set: "plan",
  decision: "decision",
  file_changed: "file_changed",
  fact: "fact",
  failure: "failure",
  architecture: "architecture",
  preference: "preference",
};

/** What an agent did, as a verb phrase, for each event kind. */
export const ACTIVITY_VERB: Record<string, string> = {
  plan_set: "set the plan",
  decision: "decided",
  file_changed: "changed",
  fact: "learned",
  failure: "hit a dead end",
  architecture: "noted how it is built",
  preference: "noted a preference",
  todo_added: "added a to-do",
  todo_done: "finished a to-do",
};

/** A plan event says what became of the plan: set, finished or dropped. */
function verbFor(e: MemoryEvent): string {
  if (e.kind === "plan_set") {
    const status = str(e.payload?.status);
    if (status === "done") return "finished the plan";
    if (status === "abandoned") return "dropped the plan";
  }
  return ACTIVITY_VERB[e.kind] ?? e.kind;
}

function lineText(e: MemoryEvent): string {
  const p = e.payload ?? {};
  if (e.kind === "file_changed") return str(p.summary);
  return str(p.text) || str(p.summary) || str(p.status) || e.key;
}

/** Index entries by `kind:key` and by `kind:content`, so an event finds the
 *  entry it became even when it carried no key. */
function entryIndex(entries: MemoryEntry[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const e of entries) {
    if (e.state === "archived") continue;
    if (e.key) index.set(`${e.kind}:k:${e.key}`, e.id);
    index.set(`${e.kind}:c:${e.content.trim()}`, e.id);
  }
  return index;
}

function entryFor(e: MemoryEvent, text: string, index: Map<string, number>): number | null {
  const kind = ENTRY_KIND[e.kind];
  if (!kind) return null;
  // Every plan shares the key "plan": by key, an old plan would open the
  // plan that stands now. A plan line links only to its own words.
  const byKey = e.key && kind !== "plan";
  return (
    (byKey ? index.get(`${kind}:k:${e.key}`) : undefined) ??
    index.get(`${kind}:c:${text.trim()}`) ??
    null
  );
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** "Today", "Yesterday", or "Mon, Sep 15" (with the year when it is not
 *  this one). */
export function dayLabel(ts: number, now: number): string {
  if (dayKey(ts) === dayKey(now)) return "Today";
  if (dayKey(ts) === dayKey(now - 86_400_000)) return "Yesterday";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

export interface ActivityFilter {
  /** Lower-cased, trimmed search; matches a line's text, path or verb. */
  query?: string;
  /** Only this agent's sessions. */
  agent?: string;
}

/** The event log as days of session groups, newest first. */
export function buildActivity(
  events: MemoryEvent[],
  entries: MemoryEntry[],
  now: number,
  filter: ActivityFilter = {},
): ActivityDay[] {
  const index = entryIndex(entries);
  const q = filter.query ?? "";
  const ordered = [...events].sort((a, b) => b.ts - a.ts || b.seq - a.seq);

  const groups: ActivityGroup[] = [];
  let current: ActivityGroup | null = null;
  for (const e of ordered) {
    if (filter.agent && e.agent !== filter.agent) continue;
    const sameSession: boolean =
      current !== null && current.sessionId === e.sessionId && current.agent === e.agent;
    if (!sameSession) {
      current = {
        key: `${e.sessionId || "none"}:${e.seq}`,
        agent: e.agent,
        sessionId: e.sessionId,
        end: e.ts,
        lines: [],
      };
      groups.push(current);
    }
    const group = current!;
    if (BRACKETS.has(e.kind)) continue;
    const text = lineText(e);
    const verb = verbFor(e);
    const path = e.kind === "file_changed" ? str(e.payload?.path) || e.key || null : null;
    if (
      q &&
      !text.toLowerCase().includes(q) &&
      !(path ?? "").toLowerCase().includes(q) &&
      !verb.includes(q) &&
      !(e.agent ?? "").toLowerCase().includes(q)
    ) {
      continue;
    }
    group.lines.push({
      seq: e.seq,
      kind: e.kind,
      verb,
      text,
      path,
      entryId: entryFor(e, text, index),
    });
  }

  const days: ActivityDay[] = [];
  for (const group of groups) {
    if (group.lines.length === 0) continue;
    const key = dayKey(group.end);
    const last = days[days.length - 1];
    if (last?.key === key) last.groups.push(group);
    else days.push({ key, label: dayLabel(group.end, now), groups: [group] });
  }
  return days;
}

/** "2 decisions, 1 file": a folded group's tally, by kind, in order of first
 *  appearance. */
export function activityTally(lines: ActivityLine[]): string {
  const NOUN: Record<string, [string, string]> = {
    plan_set: ["plan", "plans"],
    decision: ["decision", "decisions"],
    file_changed: ["file", "files"],
    fact: ["fact", "facts"],
    failure: ["dead end", "dead ends"],
    architecture: ["architecture note", "architecture notes"],
    preference: ["preference", "preferences"],
    todo_added: ["to-do", "to-dos"],
    todo_done: ["to-do done", "to-dos done"],
  };
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l.kind, (counts.get(l.kind) ?? 0) + 1);
  return [...counts]
    .map(([kind, n]) => {
      const [one, many] = NOUN[kind] ?? [kind, kind];
      return `${n} ${n === 1 ? one : many}`;
    })
    .join(", ");
}
