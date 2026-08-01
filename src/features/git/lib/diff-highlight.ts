// Synchronous, cached syntax highlighting for the git diff view. The heavy
// lowlight tokenization now lives in `diff-highlight-core.ts` (shared with the
// off-main-thread worker, `diff-highlight.worker.ts`); this module is the
// synchronous main-thread path — used by the unified diff view and as the
// fallback for the side-by-side panel when the worker is unavailable.
//
// See `diff-highlight-core.ts` for the per-line (not per-file) tradeoff.

import {
  hljsIdForLanguage,
  tokenizeLine,
  type DiffToken,
} from "./diff-highlight-core";

export type { DiffToken };

// Re-tokenizing on every virtualized scroll would defeat the "lightweight"
// goal, so cache each unique (grammar, line) result. Bounded so a giant diff
// can't grow it without limit.
const cache = new Map<string, DiffToken[] | null>();
const CACHE_CAP = 8000;

/**
 * Tokenize one diff line synchronously. Returns the colored token runs, or
 * `null` when the language is unsupported / the line is empty or too long — in
 * which case the caller should render the raw text unchanged.
 */
export function highlightDiffLine(
  language: string,
  content: string,
): DiffToken[] | null {
  const id = hljsIdForLanguage(language);
  if (!id) return null;

  const key = `${id} ${content}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const tokens = tokenizeLine(id, content);
  if (cache.size >= CACHE_CAP) cache.clear();
  cache.set(key, tokens);
  return tokens;
}
