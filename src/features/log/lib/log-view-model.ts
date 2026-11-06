/**
 * What the Log tab shows, as pure functions of the store's rows and the
 * toolbar's filters — so the panel's container only wires stores to them and
 * the view only renders their output.
 */
import type { LogEntry, LogSource } from "../stores/log-store";

export type { LogEntry, LogSource };

/** Every source, in the order the Sources menu lists them. */
export const LOG_SOURCES: readonly LogSource[] = [
  "atlas",
  "agent",
  "chat",
  "canvas",
  "git",
  "knowledge",
  "github",
  "editor",
  "project",
  "system",
];

export type LogScope = "all" | "current";

export interface LogFilters {
  search: string;
  sources: ReadonlySet<LogSource>;
  scope: LogScope;
  pinnedOnly: boolean;
}

/** Every source, the current project only, pins and buffer alike. */
export function defaultLogFilters(): LogFilters {
  return { search: "", sources: new Set(LOG_SOURCES), scope: "current", pinnedOnly: false };
}

/** The buffer then the pins, an entry in both shown once (as its buffer row). */
export function mergeLogEntries(buffer: LogEntry[], pinned: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const list of [buffer, pinned]) {
    for (const e of list) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

/** The rows the filters let through. The "current" scope with no project
 *  open shows nothing: there is no project for a row to belong to. */
export function filterLogEntries(
  entries: LogEntry[],
  filters: LogFilters,
  currentProjectPath: string | null,
): LogEntry[] {
  const q = filters.search.trim().toLowerCase();
  return entries.filter((e) => {
    if (!filters.sources.has(e.source)) return false;
    if (filters.pinnedOnly && !e.pinned) return false;
    if (filters.scope === "current") {
      if (currentProjectPath === null) return false;
      if (e.projectPath !== currentProjectPath) return false;
    }
    if (q) {
      const hay = (e.summary + " " + e.kind + " " + (e.projectName ?? "")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** One row as a line of text — what "Copy line" puts on the clipboard. */
export function formatLogLine(e: LogEntry): string {
  return `[${e.source}] ${e.kind} — ${e.summary}`;
}
