// Pure formatting for the Shared memory view: labels, times and the
// predicates its tables share. No store or IPC access.

import { agentMetaForSource } from "./memory-agent";
import { timeAgo } from "@/lib/time-ago";
import { formatDateTime } from "@/lib/format-time";
import type { MemoryEntry, MemoryEvent, Provenance } from "./shared-memory-api";

// The wire shapes the views render, re-exported type-only so a props-only view
// never names the IPC module.
export type {
  ClaudeImportLine,
  ClaudeImportPreview,
  ExportPreview,
  MemoryEntry,
  MemoryEvent,
  Provenance,
  RepoImportLine,
} from "./shared-memory-api";

/* Agent identity resolves through the registry chokepoint (`agentMeta`), so an
 * agent installed from the ACP registry gets its real name and manifest icon
 * instead of a truncated id. The local resolver this replaced knew only Claude
 * and Codex, which is how one agent could render twice under two identities. */

export const str = (v: unknown): string => (v == null ? "" : String(v));

/** One-line summary of an event's payload for the Detail column. */
export function eventDetail(e: MemoryEvent): string {
  const p = e.payload ?? {};
  return str(p.text) || str(p.summary) || str(p.path) || str(e.key) || str(p.status) || "";
}

/** Where an entry came from: the extractor, the user, an import (with its
 *  origin), or the agent that wrote it. */
export function sourceLabel(source: string): string {
  if (!source) return "—";
  if (source === "extractor" || source === "user") return source;
  if (source.startsWith("import:")) return `import · ${source.slice("import:".length)}`;
  return agentMetaForSource(source).label;
}

/** The entry's agent as a name: an import has none, and a user edit is the
 *  user's, not an agent's. `null` = not an agent. */
export function entryAgent(agent: string): string | null {
  return agent && agent !== "user" ? agent : null;
}

/** A 0–1 confidence as a whole percentage. */
export function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

export function eventTime(ts: number): string {
  if (!ts) return "—";
  return timeAgo(new Date(ts).toISOString(), { suffix: true });
}

export function fmtDateTime(ts: number): string {
  if (!ts) return "—";
  return formatDateTime(ts, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DURABLE_KINDS: ReadonlySet<string> = new Set([
  "decision",
  "fact",
  "failure",
  "architecture",
  "preference",
]);

/** Whether an entry can go into AGENTS.md: an active durable memory. A
 *  candidate is unreviewed, and the backend refuses plans, file changes and
 *  archived entries. */
export function exportable(e: MemoryEntry): boolean {
  return e.state === "active" && DURABLE_KINDS.has(e.kind);
}

export const KIND_LABEL: Record<string, string> = {
  plan_set: "plan",
  plan: "plan",
  decision: "decision",
  file_changed: "file",
  fact: "fact",
  session_start: "session start",
  session_end: "session end",
  todo_added: "todo +",
  todo_done: "todo ✓",
};

/** "Learned in “title” · agent · date → sha", or the bare source. */
export function provenanceLine(p: Provenance): string {
  const date = p.added ?? "";
  if (p.title) {
    const commit = p.commits[0] ? ` → ${p.commits[0].slice(0, 7)}` : "";
    return `Learned in “${p.title}” · ${p.agent} · ${date}${commit}`;
  }
  if (p.source === "atlas-user") return `Written by you · ${date}`;
  return `From ${p.source} · ${date}`;
}
