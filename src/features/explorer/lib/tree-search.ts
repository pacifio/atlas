// The project tree's search: what "Search files" turns the tree into.
//
// The tree filters in place. It keeps every entry whose root-relative path
// holds the query (case-insensitive), plus the folders above each one, all
// opened, and drops everything else; a hit is drawn in the heavier weight.
// Candidates come from two places: the listings the tree already holds (so a
// loaded but ignored `node_modules` is searchable), and the project's file
// index (`fileindex_search`, the ⌘P index), which knows the files in folders
// nobody has opened. The index answers fuzzily and is capped, so its answers
// are narrowed here to the same substring rule as the listings.
//
// Everything here is pure; the component debounces the query, asks the index
// and hands the answers in.

import type { ProjectEntry, ProjectEntryKind } from "./fs-api";
import { nameOf, parentOf, type TreeRowData } from "./project-tree-model";

/** Typing pause before the index is asked. Short enough to feel live, long
 *  enough that a word typed at speed asks once. */
export const SEARCH_DEBOUNCE_MS = 120;
/** Index answers per query. Past this the tree says to refine the search. */
export const SEARCH_INDEX_LIMIT = 200;

/** What the tree matches against: trimmed, lower-cased, `\` read as `/`. */
export function normalizeTreeQuery(query: string): string {
  const trimmed = query.trim();
  return (trimmed.includes("\\") ? trimmed.replaceAll("\\", "/") : trimmed).toLowerCase();
}

/**
 * The query as the index should read it: literally. The index's matcher
 * (nucleo's `Pattern::parse`) splits on spaces and treats a leading `!`, `^`
 * or `'` and a trailing `$` as operators; each is escaped with `\`, so the
 * whole query is one fuzzy needle. Takes a normalised query (no `\` left).
 */
export function literalIndexQuery(query: string): string {
  let out = query.replaceAll(" ", "\\ ");
  if (/^[!^']/.test(out)) out = `\\${out}`;
  if (out.endsWith("$")) out = `${out.slice(0, -1)}\\$`;
  return out;
}

/** What a tree's search keeps between views of one project root (see
 *  `ProjectTreeModel.view`). */
export interface TreeSearchState {
  /** The field's text. */
  query: string;
  /** The answer the tree is filtered by; null until the first one lands. */
  applied: { query: string; indexHits: readonly string[] } | null;
  /** Folders closed by hand during this search. */
  collapsed: ReadonlySet<string>;
}

/** Any segment starts with a dot. */
export const isHiddenPath = (path: string) => path.startsWith(".") || path.includes("/.");

interface Hit {
  kind: ProjectEntryKind;
  ignored: boolean;
}

export interface TreeMatches {
  /** Every matching path, root-relative. */
  hits: Map<string, Hit>;
  /** Ignored folders the listings know of, so a folder shown above a hit
   *  is dimmed like it would be in the tree. */
  ignoredDirs: Set<string>;
  /** Index answers that passed the substring rule and are still on disk:
   *  what "more matches available" is judged by. */
  indexMatched: number;
}

/** Each listing's paths as a set, built once per listing object. */
const pathSetCache = new WeakMap<readonly ProjectEntry[], Set<string>>();
function pathSet(entries: readonly ProjectEntry[]): Set<string> {
  let set = pathSetCache.get(entries);
  if (!set) {
    set = new Set(entries.map((e) => e.path));
    pathSetCache.set(entries, set);
  }
  return set;
}

/**
 * Whether the loaded listings still agree that `path` exists: every folder
 * above it whose listing is loaded lists the next step down. The index lags
 * the disk, so a file deleted or renamed a moment ago can still be in its
 * answer; the tree's own listings, refreshed by the watcher, know better.
 */
export function stillListed(
  listings: ReadonlyMap<string, readonly ProjectEntry[]>,
  path: string,
): boolean {
  let child = path;
  for (let dir = parentOf(path); ; dir = parentOf(dir)) {
    const entries = listings.get(dir);
    if (entries && !pathSet(entries).has(child)) return false;
    if (dir === "") return true;
    child = dir;
  }
}

/** Lower-cased paths per listing, built once per listing object. */
const lowerCache = new WeakMap<readonly ProjectEntry[], string[]>();
function lowerPaths(entries: readonly ProjectEntry[]): string[] {
  let lower = lowerCache.get(entries);
  if (!lower) {
    lower = entries.map((e) => e.path.toLowerCase());
    lowerCache.set(entries, lower);
  }
  return lower;
}

/**
 * Every path whose root-relative path holds `query` (already normalised):
 * the loaded listings' entries, then the index's files that the listings do
 * not contradict (`stillListed`). A hidden path (any segment starting with a
 * dot) counts only when hidden files are shown.
 */
export function collectMatches(
  listings: ReadonlyMap<string, readonly ProjectEntry[]>,
  indexHits: readonly string[],
  query: string,
  showHidden: boolean,
): TreeMatches {
  const hits = new Map<string, Hit>();
  const ignoredDirs = new Set<string>();
  let indexMatched = 0;
  if (!query) return { hits, ignoredDirs, indexMatched };
  for (const entries of listings.values()) {
    const lower = lowerPaths(entries);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.ignored && entry.kind === "directory") ignoredDirs.add(entry.path);
      if (!lower[i].includes(query)) continue;
      if (!showHidden && isHiddenPath(entry.path)) continue;
      hits.set(entry.path, { kind: entry.kind, ignored: entry.ignored === true });
    }
  }
  for (const path of indexHits) {
    if (!path.toLowerCase().includes(query)) continue;
    if (!showHidden && isHiddenPath(path)) continue;
    if (!stillListed(listings, path)) continue;
    indexMatched++;
    if (!hits.has(path)) hits.set(path, { kind: "file", ignored: false });
  }
  return { hits, ignoredDirs, indexMatched };
}

interface SearchNode {
  path: string;
  name: string;
  kind: ProjectEntryKind;
  ignored: boolean;
  match: boolean;
  children: SearchNode[];
}

/** Folders first, then by case-insensitive name: the listings' own order. */
function byListingOrder(a: SearchNode, b: SearchNode): number {
  const da = a.kind === "directory" ? 0 : 1;
  const db = b.kind === "directory" ? 0 : 1;
  if (da !== db) return da - db;
  const na = a.name.toLowerCase();
  const nb = b.name.toLowerCase();
  return na < nb ? -1 : na > nb ? 1 : 0;
}

export interface SearchRows {
  rows: TreeRowData[];
  /** Hits drawn (a hit under a folder closed by hand still counts). */
  matchCount: number;
  /** The index answered a full page that all held: there may be more. */
  truncated: boolean;
  /** The first hit in tree order, for the tree's focus. */
  firstMatch: string | null;
}

/**
 * The filtered tree as rows: the hits and the folders above them, depth
 * first in listing order, every folder open unless the user closed it during
 * this search (`collapsed`, by the row's path). A folder whose only shown
 * child is a folder is compacted with it, as in the tree.
 */
export function buildSearchRows(
  { hits, ignoredDirs, indexMatched }: TreeMatches,
  collapsed: ReadonlySet<string> = new Set(),
): SearchRows {
  const root: SearchNode = {
    path: "",
    name: "",
    kind: "directory",
    ignored: false,
    match: false,
    children: [],
  };
  const nodes = new Map<string, SearchNode>([["", root]]);
  const nodeFor = (path: string): SearchNode => {
    let node = nodes.get(path);
    if (node) return node;
    node = {
      path,
      name: nameOf(path),
      kind: "directory",
      ignored: ignoredDirs.has(path),
      match: false,
      children: [],
    };
    nodes.set(path, node);
    nodeFor(parentOf(path)).children.push(node);
    return node;
  };
  for (const [path, hit] of hits) {
    const node = nodeFor(path);
    node.kind = hit.kind;
    node.ignored = hit.ignored;
    node.match = true;
  }

  const rows: TreeRowData[] = [];
  let firstMatch: string | null = null;
  const walk = (node: SearchNode, depth: number) => {
    node.children.sort(byListingOrder);
    for (const child of node.children) {
      let tail = child;
      let chain: string[] | null = null;
      let match = child.match;
      while (
        tail.kind === "directory" &&
        tail.children.length === 1 &&
        tail.children[0].kind === "directory"
      ) {
        chain ??= [child.path];
        tail = tail.children[0];
        chain.push(tail.path);
        match ||= tail.match;
      }
      if (match) firstMatch ??= tail.path;
      rows.push({
        path: tail.path,
        name: tail.name,
        depth,
        kind: tail.kind,
        ignored: tail.ignored,
        hidden: tail.name.startsWith("."),
        match,
        ...(chain ? { chain } : {}),
      });
      if (tail.kind === "directory" && !collapsed.has(tail.path)) walk(tail, depth + 1);
    }
  };
  walk(root, 0);
  return {
    rows,
    matchCount: hits.size,
    truncated: hits.size > 0 && indexMatched >= SEARCH_INDEX_LIMIT,
    firstMatch,
  };
}
