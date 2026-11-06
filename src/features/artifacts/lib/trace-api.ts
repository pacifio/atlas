/**
 * Reading the Trace: the Sessions active in a time window, each with its
 * Checkpoints — the server's `GET /sessions/trace` through Rust, plus this
 * machine's own Sessions.
 */

import { invoke } from "@tauri-apps/api/core";

import type { ProjectFilter, TracePage, TraceSessionRow } from "../types";

export interface TraceRange {
  /** ISO 8601. */
  from: string;
  /** ISO 8601. */
  to: string;
}

/** The server refuses a window wider than this. */
export const TRACE_MAX_DAYS = 92;

/** Pages one read walks before stopping and saying so. */
const MAX_PAGES = 20;

/** One page. `filter` narrows to a Project (`workspace=`); `null` is the whole
 *  Organisation. */
export function readTracePage(
  projects: string[],
  filter: ProjectFilter | null,
  range: TraceRange,
  cursor: string | null,
): Promise<TracePage> {
  return invoke<TracePage>("artifacts_trace", {
    projects,
    filter,
    from: range.from,
    to: range.to,
    cursor,
  });
}

/** A window the server will accept: `from` pulled in to at most
 *  {@link TRACE_MAX_DAYS} before `to`. */
export function clampRange(range: TraceRange): TraceRange {
  const to = Date.parse(range.to);
  const earliest = to - TRACE_MAX_DAYS * 24 * 60 * 60 * 1000;
  return Date.parse(range.from) < earliest
    ? { from: new Date(earliest).toISOString(), to: range.to }
    : range;
}

/** A whole window, every page folded together. */
export interface TraceRead {
  /** The window actually read — clamped to what the server accepts. */
  range: TraceRange;
  sessions: TraceSessionRow[];
  notes: string[];
  /** Workspace id → the name the Organisation gave it. */
  projectNames: Map<string, string>;
}

/** Every page of a window, walked through `nextCursor`. */
export async function readTrace(
  projects: string[],
  filter: ProjectFilter | null,
  range: TraceRange,
): Promise<TraceRead> {
  const window = clampRange(range);
  const sessions: TraceSessionRow[] = [];
  const notes: string[] = [];
  const projectNames = new Map<string, string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const answer: TracePage = await readTracePage(projects, filter, window, cursor);
    sessions.push(...answer.sessions);
    notes.push(...answer.notes);
    for (const w of answer.workspaces) {
      const name = w.name ?? w.slug;
      if (name) projectNames.set(w.id, name);
    }
    cursor = answer.nextCursor;
    if (!cursor) break;
  }
  if (cursor) notes.push("Showing part of this window only — narrow it to see the rest.");
  return { range: window, sessions, notes: [...new Set(notes)], projectNames };
}
