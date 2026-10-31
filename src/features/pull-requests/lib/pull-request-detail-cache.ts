// The last read of the pull requests opened most recently, kept on this
// machine so a tab paints at once — after a restart, or on a pull request
// opened a moment ago — while the fresh read runs. Stale by nature: it is
// only ever placeholder data (`usePrDetail`), never what an action decides
// on once the read lands.
//
// Bounded twice: the last `MAX_ENTRIES` pull requests, and `MAX_BYTES` of
// JSON in all, the oldest dropped first. A description long enough to blow
// the budget on its own is kept cut short rather than not at all. Storage
// that is full, blocked or unreadable only means a slower first paint.

import type { PrDetail } from "./pull-requests-types";

export const MAX_ENTRIES = 20;
export const MAX_BYTES = 512 * 1024;
/** One description's share of the budget, past which it is cut. */
const MAX_BODY_CHARS = 16 * 1024;

const STORAGE_KEY = "atlas.pullRequests.detail.v1";

interface Entry {
  /** `<checkout>\0<number>`. */
  key: string;
  detail: PrDetail;
}

function storage(given?: Storage): Storage | undefined {
  if (given) return given;
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

const keyOf = (repoPath: string, number: number) => `${repoPath}\0${number}`;

function isDetail(value: unknown, number: number): value is PrDetail {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    d.number === number &&
    typeof d.title === "string" &&
    typeof d.url === "string" &&
    typeof d.state === "string" &&
    typeof d.headBranch === "string" &&
    typeof d.baseBranch === "string" &&
    typeof d.capabilities === "object" &&
    d.capabilities !== null &&
    typeof d.viewerPermissions === "object" &&
    d.viewerPermissions !== null &&
    Array.isArray(d.checks) &&
    Array.isArray(d.labels) &&
    Array.isArray(d.reviewers)
  );
}

function readAll(given?: Storage): Entry[] {
  try {
    const raw = storage(given)?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is Entry =>
        typeof e === "object" && e !== null && typeof (e as Entry).key === "string",
    );
  } catch {
    return [];
  }
}

/** The detail last read for `number` in `repoPath`, or `undefined`. */
export function readCachedPullRequestDetail(
  repoPath: string,
  number: number,
  given?: Storage,
): PrDetail | undefined {
  const key = keyOf(repoPath, number);
  const found = readAll(given).find((e) => e.key === key)?.detail;
  return isDetail(found, number) ? found : undefined;
}

/** Keep `detail` as the newest entry, within both bounds. */
export function writeCachedPullRequestDetail(
  repoPath: string,
  detail: PrDetail,
  given?: Storage,
): void {
  const key = keyOf(repoPath, detail.number);
  const kept: PrDetail =
    detail.body.length > MAX_BODY_CHARS
      ? { ...detail, body: `${detail.body.slice(0, MAX_BODY_CHARS)}…` }
      : detail;
  const entries = [{ key, detail: kept }, ...readAll(given).filter((e) => e.key !== key)].slice(
    0,
    MAX_ENTRIES,
  );
  let json = JSON.stringify(entries);
  while (json.length > MAX_BYTES && entries.length > 1) {
    entries.pop();
    json = JSON.stringify(entries);
  }
  if (json.length > MAX_BYTES) return;
  try {
    storage(given)?.setItem(STORAGE_KEY, json);
  } catch {
    // Full or blocked: the next open reads from the host, as before.
  }
}
