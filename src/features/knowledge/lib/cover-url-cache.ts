/**
 * KB cover-image data URLs, keyed `projectPath|coverRef`.
 *
 * Covers live under `.atlas/` (asset protocol 403s it), so they're fetched as
 * base64 data URLs over IPC — multi-MB JSON strings. The ref is derived from
 * the entry id (`covers/<entryId>.<ext>`), stable across page switches, so
 * without a cache every navigation between covered pages re-read + re-encoded
 * + re-shipped the image: a visible loading flash and a main-thread parse
 * hitch each time. Bounded FIFO (re-insert refreshes recency).
 *
 * NOT immutable per ref: re-uploading a cover for the same entry with the same
 * extension reuses the ref — `evictCoverUrl` after upload keeps it honest.
 */
const cache = new Map<string, string>();
const CAP = 32;

export const coverCacheKey = (projectPath: string, cover: string): string =>
  `${projectPath}|${cover}`;

export function getCachedCoverUrl(key: string): string | null {
  return cache.get(key) ?? null;
}

export function putCachedCoverUrl(key: string, url: string): void {
  cache.delete(key);
  cache.set(key, url);
  if (cache.size > CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function evictCoverUrl(projectPath: string, cover: string): void {
  cache.delete(coverCacheKey(projectPath, cover));
}
