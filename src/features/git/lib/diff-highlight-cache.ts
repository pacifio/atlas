// Off-main-thread git-diff highlight orchestration. Given a file's diff lines,
// tokenizes them ONCE in a Web Worker and returns a `Map<lineText, tokens>` the
// panel reads synchronously per row — so mounting a virtualized row (scroll or
// jump) is a cheap map lookup, never a lowlight tokenize. Modeled on
// `src/lib/markdown-cache.tsx` (lazy singleton worker, id-correlation, warm-up
// ping, 3s watchdog → main-thread fallback).

import DiffHighlightWorker from "./diff-highlight.worker?worker";
import { hljsIdForLanguage, tokenizeLine, type DiffToken } from "./diff-highlight-core";

/** Resolved per-file result: unique line text → its tokens (`null` = plain). */
export type LineTokens = Map<string, DiffToken[] | null>;

// Insertion-ordered LRU of resolved files. A handful of open diffs is plenty;
// bounded so a session that opens many files can't grow this unbounded.
const CACHE_MAX = 24;
const cache = new Map<string, LineTokens>();
// Dedupe concurrent requests for the same file key.
const pending = new Map<string, Promise<LineTokens>>();

function cacheGet(key: string): LineTokens | undefined {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

function cacheSet(key: string, value: LineTokens): void {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Already-resolved tokens for a file key, if any — lets the panel paint
 *  highlighted immediately when a diff tab is reopened. */
export function getCachedHighlight(key: string): LineTokens | undefined {
  return cacheGet(key);
}

// ── Worker client ───────────────────────────────────────────────────────────

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const waiters = new Map<number, (tokens: (DiffToken[] | null)[]) => void>();

function ensureWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    worker = new DiffHighlightWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; tokens: (DiffToken[] | null)[] }>) => {
      const resolve = waiters.get(e.data.id);
      if (resolve) {
        waiters.delete(e.data.id);
        resolve(e.data.tokens);
      }
    };
    worker.onerror = () => {
      workerBroken = true;
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

/** Nudge the highlight worker awake. WebKit suspends idle Web Workers, so the
 *  first diff opened after the window was idle would otherwise pay a cold
 *  round-trip (or hit the watchdog). The echoed reply carries an id no waiter
 *  is registered for, so it's harmlessly ignored. */
export function warmDiffHighlightWorker(): void {
  const w = ensureWorker();
  if (w) {
    try {
      w.postMessage({ id: -1, hljsId: "", lines: [] });
    } catch {
      /* ignore */
    }
  }
}

/** Tokenize a set of unique lines on the main thread, chunked via
 *  `requestIdleCallback` so a broken-worker fallback doesn't freeze the frame. */
function fallbackTokenize(hljsId: string, unique: string[]): Promise<(DiffToken[] | null)[]> {
  return new Promise((resolve) => {
    const out: (DiffToken[] | null)[] = Array.from({ length: unique.length });
    let i = 0;
    const CHUNK = 200;
    const w2 = window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
    };
    const step = () => {
      const end = Math.min(unique.length, i + CHUNK);
      for (; i < end; i++) out[i] = tokenizeLine(hljsId, unique[i]);
      if (i < unique.length) schedule();
      else resolve(out);
    };
    const schedule = () =>
      typeof w2.requestIdleCallback === "function"
        ? w2.requestIdleCallback(step, { timeout: 250 })
        : window.setTimeout(step, 16);
    schedule();
  });
}

/**
 * Ensure highlight tokens for `lines` (a file's diff line strings) exist for
 * `key`, computing them once off the main thread. Resolves to a stable
 * `Map<lineText, tokens>`. Unsupported languages resolve to an empty map (the
 * caller renders raw text). Deduped by key; cached (bounded LRU).
 */
export function ensureDiffHighlight(
  key: string,
  language: string,
  lines: string[],
): Promise<LineTokens> {
  const hit = cacheGet(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const hljsId = hljsIdForLanguage(language);
  if (!hljsId) {
    // Unsupported language → nothing to highlight; cache an empty map so the
    // panel stops asking and renders raw text.
    const empty: LineTokens = new Map();
    cacheSet(key, empty);
    return Promise.resolve(empty);
  }

  const unique = Array.from(new Set(lines));

  const build = (toks: (DiffToken[] | null)[]): LineTokens => {
    const map: LineTokens = new Map();
    for (let i = 0; i < unique.length; i++) map.set(unique[i], toks[i] ?? null);
    cacheSet(key, map);
    return map;
  };

  const w = ensureWorker();
  let p: Promise<LineTokens>;
  if (w) {
    p = new Promise<LineTokens>((resolve) => {
      const id = ++seq;
      let settled = false;
      const finish = (toks: (DiffToken[] | null)[]) => {
        if (settled) return;
        settled = true;
        waiters.delete(id);
        resolve(build(toks));
      };
      waiters.set(id, finish);
      // Watchdog: if the worker never answers (script failed to load, etc.),
      // fall back to a chunked main-thread tokenize so the diff still colors.
      window.setTimeout(() => {
        if (!settled) {
          workerBroken = true;
          void fallbackTokenize(hljsId, unique).then(finish);
        }
      }, 3000);
      w.postMessage({ id, hljsId, lines: unique });
    });
  } else {
    p = fallbackTokenize(hljsId, unique).then(build);
  }

  const tracked = p.then((map) => {
    pending.delete(key);
    return map;
  });
  pending.set(key, tracked);
  return tracked;
}
