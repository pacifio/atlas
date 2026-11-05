// ⌘P's rows, as data: the files an empty query lists first, and where a
// query's characters fall in a file's name so the row can pick them out. The
// directory path underneath stays plain: letters lit at scattered points of a
// long path read as noise, not as a match.
//
// The ranking itself is Rust's (nucleo over the FileIndex, `fileindex_search`):
// the order the backend returns is kept, and nothing here re-sorts it.

import type { FileMatch } from "@/features/file-picker/lib/file-picker-api";

/** The most rows ⌘P lists; only this many cross the IPC boundary. */
export const FILE_SEARCH_RESULT_LIMIT = 200;

export interface FileSearchMatch {
  /** Absolute: what opening the file takes. */
  readonly path: string;
  /** Project-relative: the row's second line. */
  readonly rel: string;
  readonly name: string;
  /** Where the query falls in `name`; empty when it does not fall there. */
  readonly nameMatchIndices: ReadonlyArray<number>;
}

/** A run of `value`'s text, matched or not. */
export interface HighlightSegment {
  readonly text: string;
  readonly matched: boolean;
}

/**
 * `value` cut into runs at the matched indices, with adjacent matched
 * characters kept in one run, so a row renders a few spans rather than one
 * per letter (and the shaping across a matched run is not broken up).
 */
export function highlightSegments(
  value: string,
  indices: ReadonlyArray<number>,
): HighlightSegment[] {
  const segments: HighlightSegment[] = [];
  const push = (text: string, matched: boolean) => {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && last.matched === matched) {
      segments[segments.length - 1] = { text: last.text + text, matched };
    } else {
      segments.push({ text, matched });
    }
  };
  let start = 0;
  for (const index of indices) {
    if (index < start || index >= value.length) continue;
    push(value.slice(start, index), false);
    push(value.charAt(index), true);
    start = index + 1;
  }
  push(value.slice(start), false);
  return segments;
}

export function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** The query as the backend matched it: lowercase, no whitespace, and no
 *  leading `@`, `.` or `/` (typed out of habit, never part of a match). */
export function normalizeFileQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[@./]+/, "")
    .replace(/\s/g, "");
}

/** Where `query`'s characters fall in `value`, in order (a subsequence), or
 *  `null` when they do not all appear — the row still renders (the backend
 *  matched it on other grounds), just without highlights. */
export function findMatchIndices(value: string, query: string): number[] | null {
  if (!query) return [];
  const lower = value.toLowerCase();
  const indices: number[] = [];
  let q = 0;
  for (let i = 0; i < lower.length; i += 1) {
    if (lower[i] !== query[q]) continue;
    indices.push(i);
    q += 1;
    if (q === query.length) return indices;
  }
  return null;
}

/** The backend's files as rows, in its order, with highlight positions. */
export function toFileSearchMatches(
  entries: ReadonlyArray<FileMatch>,
  rawQuery: string,
  limit = FILE_SEARCH_RESULT_LIMIT,
): FileSearchMatch[] {
  const query = normalizeFileQuery(rawQuery);
  return entries.slice(0, Math.max(0, limit)).map((entry) => {
    const name = fileName(entry.rel || entry.path);
    return {
      path: entry.path,
      rel: entry.rel,
      name,
      nameMatchIndices: findMatchIndices(name, query) ?? [],
    };
  });
}

/** `path` relative to `root`, or `null` when it is not inside it. */
export function relativeTo(root: string, path: string): string | null {
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : null;
}

/**
 * What an empty query lists: the files open in tabs first, then the recently
 * opened ones (most recent first), then the index's own walk order — each
 * file once, only files inside the project, at most `limit`.
 */
export function emptyQueryFiles(input: {
  projectPath: string;
  openFiles: ReadonlyArray<string>;
  recentFiles: ReadonlyArray<{ absPath: string; touchedAt: number }>;
  indexed: ReadonlyArray<FileMatch>;
  limit?: number;
}): FileMatch[] {
  const limit = input.limit ?? FILE_SEARCH_RESULT_LIMIT;
  const seen = new Set<string>();
  const out: FileMatch[] = [];
  const add = (path: string, rel: string | null) => {
    if (rel === null || rel === "" || seen.has(path) || out.length >= limit) return;
    seen.add(path);
    out.push({ path, rel });
  };
  for (const path of input.openFiles) add(path, relativeTo(input.projectPath, path));
  const recents = [...input.recentFiles].sort((a, b) => b.touchedAt - a.touchedAt);
  for (const recent of recents) add(recent.absPath, relativeTo(input.projectPath, recent.absPath));
  for (const entry of input.indexed) add(entry.path, entry.rel);
  return out;
}
