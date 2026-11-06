// Pure shaping for the Memories tab: which entries show, how they group, and
// how an entry's provenance points back at the session that wrote it. No store
// or IPC access, so the views and their tests share it.

import type { EntryKind, MemoryEntry, Provenance } from "./shared-memory-api";
import { sourceLabel } from "./shared-memory-format";

/** Which entries the list shows: what agents read now (active and still
 *  unconfirmed), or what was set aside (archived, kept in history). */
export type EntryScope = "current" | "archived";

/** The order the list's groups read in: what was decided and how the system
 *  is built first, the incidental last. */
export const KIND_ORDER: readonly EntryKind[] = [
  "plan",
  "decision",
  "architecture",
  "preference",
  "fact",
  "failure",
  "file_changed",
];

/** A group's heading, plural. */
export const KIND_GROUP_LABEL: Record<string, string> = {
  plan: "Plan",
  decision: "Decisions",
  architecture: "Architecture",
  preference: "Preferences",
  fact: "Facts",
  failure: "Dead ends",
  file_changed: "Files changed",
};

/** One entry's kind as a singular noun, for its detail and tooltip. */
export const KIND_NOUN: Record<string, string> = {
  plan: "Plan",
  decision: "Decision",
  architecture: "Architecture",
  preference: "Preference",
  fact: "Fact",
  failure: "Dead end",
  file_changed: "File change",
};

export function kindNoun(kind: string): string {
  return KIND_NOUN[kind] ?? kind.replace(/_/g, " ");
}

export interface EntryGroup {
  kind: string;
  label: string;
  entries: MemoryEntry[];
}

export function inScope(e: MemoryEntry, scope: EntryScope): boolean {
  return scope === "archived" ? e.state === "archived" : e.state !== "archived";
}

/** Whether `e` matches the search `q` (already lower-cased and trimmed). */
export function entryMatches(e: MemoryEntry, q: string): boolean {
  if (!q) return true;
  return (
    e.content.toLowerCase().includes(q) ||
    e.key.toLowerCase().includes(q) ||
    e.kind.toLowerCase().includes(q) ||
    kindNoun(e.kind).toLowerCase().includes(q) ||
    sourceLabel(e.source).toLowerCase().includes(q) ||
    e.agent.toLowerCase().includes(q)
  );
}

/** Entries grouped by kind in `KIND_ORDER` (unknown kinds last), newest
 *  write first inside each group. Empty groups are dropped. */
export function groupEntries(entries: MemoryEntry[]): EntryGroup[] {
  const byKind = new Map<string, MemoryEntry[]>();
  for (const e of entries) {
    const list = byKind.get(e.kind);
    if (list) list.push(e);
    else byKind.set(e.kind, [e]);
  }
  const rank = (k: string) => {
    const i = KIND_ORDER.indexOf(k as EntryKind);
    return i === -1 ? KIND_ORDER.length : i;
  };
  return [...byKind.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((kind) => ({
      kind,
      label: KIND_GROUP_LABEL[kind] ?? kind.replace(/_/g, " "),
      entries: byKind
        .get(kind)!
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt),
    }));
}

/** The session a provenance names, when it names one:
 *  `atlas-session:<agent>/<session>` → `{ agent, sessionId }`. */
export function provenanceSession(p: Provenance): { agent: string; sessionId: string } | null {
  const m = /^atlas-session:([^/]+)\/(.+)$/.exec(p.source);
  return m ? { agent: m[1], sessionId: m[2] } : null;
}

/** What the list says at a glance about how much an entry is relied on:
 *  "used 7×", or nothing for an entry no agent has read yet. */
export function usesLabel(uses: number): string | null {
  return uses > 0 ? `used ${uses}×` : null;
}

/** Whether to show an entry's confidence. A user's or a tool's write is
 *  certain, and saying "100%" on every row is noise. */
export function showsConfidence(e: MemoryEntry): boolean {
  return e.confidence < 1;
}

/** Counts for the overview: how many current entries, how many agents wrote
 *  them, and the newest write. */
export function memorySummary(entries: MemoryEntry[]): {
  current: number;
  unconfirmed: number;
  archived: number;
  agents: string[];
  newest: MemoryEntry | null;
} {
  const current = entries.filter((e) => e.state !== "archived");
  const agents = [...new Set(current.map((e) => e.agent).filter((a) => a && a !== "user"))];
  const newest = current.reduce<MemoryEntry | null>(
    (best, e) => (!best || e.updatedAt > best.updatedAt ? e : best),
    null,
  );
  return {
    current: current.length,
    unconfirmed: current.filter((e) => e.state === "candidate").length,
    archived: entries.length - current.length,
    agents,
    newest,
  };
}

/** The current entries agents lean on most, for the overview. */
export function mostUsed(entries: MemoryEntry[], n = 3): MemoryEntry[] {
  return entries
    .filter((e) => e.state === "active" && e.uses > 0)
    .sort((a, b) => b.uses - a.uses || b.updatedAt - a.updatedAt)
    .slice(0, n);
}
