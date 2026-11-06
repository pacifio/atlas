/**
 * How the pull-request list was last left: state, involvement, sort and the
 * local filters. A per-viewer convenience in `localStorage`, so every read
 * and write survives storage being absent or refusing; anything unreadable
 * falls back to the defaults. The search box is not kept.
 *
 * Also the last list itself (`readPullRequestListSnapshot`), per checkout,
 * so reopening the tab paints rows at once while the host is asked again.
 */

import type { PullRequestListSort, PullRequestLocalFilters } from "./pull-request-list-logic";
import type { PrInvolvement, PrListEntry, PrListState, PrProvider } from "./pull-requests-types";

export interface PullRequestListPreferences {
  state: PrListState;
  involvement: PrInvolvement;
  sort: PullRequestListSort;
  filters: PullRequestLocalFilters;
}

export const DEFAULT_PULL_REQUEST_LIST_PREFERENCES: PullRequestListPreferences = {
  state: "open",
  involvement: "all",
  sort: "ready",
  filters: {},
};

const STORAGE_KEY = "atlas.pullRequests.listPreferences";

const STATES = new Set<PrListState>(["all", "open", "closed", "merged"]);
const INVOLVEMENTS = new Set<PrInvolvement>(["all", "authored", "reviewing"]);
const SORTS = new Set<PullRequestListSort>([
  "ready",
  "blocked",
  "updated",
  "newest",
  "oldest",
  "largest",
  "smallest",
]);
const REVIEWS = new Set(["approved", "changes-requested", "review-required", "none"]);

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

function storage(given?: Storage): Storage | undefined {
  if (given) return given;
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

const bounded = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200;

/** Whatever of `raw` is valid, over the defaults. */
export function decodePullRequestListPreferences(raw: unknown): PullRequestListPreferences {
  const prefs = { ...DEFAULT_PULL_REQUEST_LIST_PREFERENCES, filters: {} };
  if (typeof raw !== "object" || raw === null) return prefs;
  const r = raw as Record<string, unknown>;
  if (STATES.has(r.state as PrListState)) prefs.state = r.state as PrListState;
  if (INVOLVEMENTS.has(r.involvement as PrInvolvement)) {
    prefs.involvement = r.involvement as PrInvolvement;
  }
  if (SORTS.has(r.sort as PullRequestListSort)) prefs.sort = r.sort as PullRequestListSort;
  const f = (typeof r.filters === "object" && r.filters !== null ? r.filters : {}) as Record<
    string,
    unknown
  >;
  const filters: PullRequestLocalFilters = {};
  if (f.draft === "only" || f.draft === "hide") filters.draft = f.draft;
  if (REVIEWS.has(f.review as string))
    filters.review = f.review as PullRequestLocalFilters["review"];
  if (f.checks === "passing" || f.checks === "failing") filters.checks = f.checks;
  if (bounded(f.author)) filters.author = f.author;
  if (Array.isArray(f.labels)) {
    const labels = f.labels.filter(bounded).slice(0, 10);
    if (labels.length > 0) filters.labels = labels;
  }
  prefs.filters = filters;
  return prefs;
}

export function readPullRequestListPreferences(given?: Storage): PullRequestListPreferences {
  try {
    const raw = storage(given)?.getItem(STORAGE_KEY);
    return raw
      ? decodePullRequestListPreferences(JSON.parse(raw))
      : DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
  } catch {
    return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
  }
}

// ── the last list, for an instant reopen ────────────────────────────────

/** Rows kept: the first page, which is what a reopen paints first. */
export const SNAPSHOT_MAX_ENTRIES = 50;

const snapshotKey = (repoPath: string) => `atlas.pullRequests.list:${repoPath}`;

export interface PullRequestListSnapshot {
  /** Which listing these rows answer (state, involvement, filters). */
  scope: string;
  provider: PrProvider;
  entries: PrListEntry[];
}

const isEntry = (value: unknown): value is PrListEntry => {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.number === "number" &&
    typeof e.title === "string" &&
    typeof e.url === "string" &&
    typeof e.state === "string" &&
    typeof e.updatedAt === "string" &&
    typeof e.createdAt === "string" &&
    typeof e.headBranch === "string" &&
    typeof e.baseBranch === "string" &&
    Array.isArray(e.labels)
  );
};

/** The rows the list last showed for `repoPath` under `scope`, or `null`.
 *  Stale by nature: the list paints them and reads again at once. */
export function readPullRequestListSnapshot(
  repoPath: string,
  scope: string,
  given?: Storage,
): PullRequestListSnapshot | null {
  try {
    const raw = storage(given)?.getItem(snapshotKey(repoPath));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PullRequestListSnapshot>;
    if (parsed.scope !== scope || typeof parsed.provider !== "object" || !parsed.provider) {
      return null;
    }
    if (!Array.isArray(parsed.entries) || !parsed.entries.every(isEntry)) return null;
    return {
      scope,
      provider: parsed.provider,
      entries: parsed.entries.slice(0, SNAPSHOT_MAX_ENTRIES),
    };
  } catch {
    return null;
  }
}

export function writePullRequestListSnapshot(
  repoPath: string,
  snapshot: PullRequestListSnapshot,
  given?: Storage,
): void {
  try {
    storage(given)?.setItem(
      snapshotKey(repoPath),
      JSON.stringify({ ...snapshot, entries: snapshot.entries.slice(0, SNAPSHOT_MAX_ENTRIES) }),
    );
  } catch {
    // Full or blocked: the next open reads from the host, as before.
  }
}

export function writePullRequestListPreferences(
  prefs: PullRequestListPreferences,
  given?: Storage,
): void {
  try {
    storage(given)?.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // A private window or blocked storage: the list still works, unremembered.
  }
}
