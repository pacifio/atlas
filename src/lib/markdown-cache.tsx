// Markdown → HTML cache for the chat thread. Built once per unique source
// string and stored in a bounded LRU so virtualizer remounts (scroll a
// message off-screen and back in) don't re-parse markdown or re-run
// highlight.js — the cost was visible as scroll-back jank on long
// code-heavy answers.
//
// The actual parse pipeline lives in `markdown-render.ts` and runs in a Web
// Worker (`markdown.worker.ts`) for large blocks, so the synchronous
// remark+highlight long task no longer competes with the chat composer's
// keystrokes. Small blocks (< SYNC_LIMIT) and cache hits still render
// synchronously on the main thread — they're cheap and avoid a paint flash.
// If the worker can't start, we fall back to the previous gated-idle parse.

import { useEffect, useRef, useState } from "react";
import { isTypingHot } from "./input-activity";
import MarkdownWorker from "./markdown.worker?worker";
import "highlight.js/styles/github-dark.css";
import { cn } from "./utils";

// Insertion-ordered Map → simple LRU via delete+set on hit. Bounded so a
// thread of thousands of unique strings can't grow this unbounded.
//
// Sized in CHARACTERS, not entries. The old 250-entry bound predates block
// splitting: one message used to be one entry, then became N blocks, and a
// code-heavy thread blew through 250 entries while barely using any memory —
// evicting exactly the settled blocks the cache exists to protect, so
// scroll-back re-parsed everything. ~4 MB of source keys is a few thousand
// typical blocks; the HTML roughly doubles that, still trivial for a desktop
// webview.
const CACHE_MAX_CHARS = 4_000_000;
const cache = new Map<string, string>();
let cacheChars = 0;

// Blocks at or below this length parse synchronously on the main thread:
// they're sub-millisecond and going async would flash empty content. Larger
// blocks (the ones that caused the long task) go to the worker.
const SYNC_LIMIT = 2000;

function cacheGet(src: string): string | undefined {
  const cached = cache.get(src);
  if (cached !== undefined) {
    cache.delete(src);
    cache.set(src, cached);
  }
  return cached;
}

function cacheSet(src: string, html: string): void {
  const prev = cache.get(src);
  if (prev !== undefined) cacheChars -= src.length + prev.length;
  cache.set(src, html);
  cacheChars += src.length + html.length;
  while (cacheChars > CACHE_MAX_CHARS && cache.size > 1) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cacheChars -= oldest.length + (cache.get(oldest)?.length ?? 0);
    cache.delete(oldest);
  }
}

// ── Main-thread renderer (lazily loaded) ───────────────────────────────────
//
// `markdown-render.ts` pulls the whole unified/remark/rehype/highlight.js
// pipeline — ~554 KB. `App.tsx` imports `warmMarkdownWorker` from this module
// on the boot path, so a STATIC import here put that entire stack in the eager
// entry chunk, parsed before React's first paint, as a second copy of what
// `markdown.worker.ts` already carries. Loading it through `import()` keeps it
// out of the entry's static graph (Vite only preloads that graph) while
// `primeMarkdownRenderer()` still gets it resident well before the first chat
// block renders, so the synchronous small-block path below behaves as before.

type RenderModule = typeof import("./markdown-render");

let renderMod: RenderModule | null = null;
let renderModPromise: Promise<RenderModule> | null = null;

function ensureRenderer(): Promise<RenderModule> {
  if (!renderModPromise) {
    renderModPromise = import("./markdown-render").then((m) => {
      renderMod = m;
      return m;
    });
  }
  return renderModPromise;
}

/** Start loading the main-thread renderer chunk. Safe to call repeatedly. */
export function primeMarkdownRenderer(): void {
  void ensureRenderer();
}

/** Synchronous parse on the main thread, with caching — but only if the
 *  renderer chunk is already resident. Returns `null` when it isn't, so the
 *  caller can route the block through the worker instead of blocking on a
 *  module load. */
function renderToHtmlSyncIfReady(src: string): string | null {
  const cached = cacheGet(src);
  if (cached !== undefined) return cached;
  if (!renderMod) {
    void ensureRenderer();
    return null;
  }
  const html = renderMod.parseMarkdown(src);
  cacheSet(src, html);
  return html;
}

/** Main-thread parse, loading the renderer chunk first if needed. The
 *  worker-unavailable fallback path — correctness over latency. */
async function renderToHtmlAsync(src: string): Promise<string> {
  const cached = cacheGet(src);
  if (cached !== undefined) return cached;
  const m = await ensureRenderer();
  const html = m.parseMarkdown(src);
  cacheSet(src, html);
  return html;
}

// ── Off-thread parse client ────────────────────────────────────────────────

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
// Waiters keep their SOURCE so a worker failure can settle them synchronously —
// without it each in-flight block sat blank until its own 3s watchdog fired.
const waiters = new Map<number, { source: string; finish: (html: string) => void }>();
// Dedupe concurrent requests for the same source so two visible copies of an
// identical message don't parse twice.
const pending = new Map<string, Promise<string>>();

function ensureWorker(): Worker | null {
  // Order matters: once the watchdog (or onerror) marks the worker broken, hand
  // back null even though `worker` is still non-null. Returning the dead worker
  // here kept every later large block on the worker branch, where each one
  // waited out the full 3s watchdog before falling back to a sync parse.
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new MarkdownWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; html: string }>) => {
      const waiter = waiters.get(e.data.id);
      if (waiter) {
        waiters.delete(e.data.id);
        waiter.finish(e.data.html);
      }
    };
    worker.onerror = () => {
      // Stop using the worker AND settle everything in flight via the sync
      // path right now, instead of letting each waiter eat its own watchdog.
      workerBroken = true;
      const stranded = Array.from(waiters.values());
      waiters.clear();
      for (const w of stranded) void renderToHtmlAsync(w.source).then(w.finish);
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

/** Nudge the markdown worker awake. WebKit can suspend Web Workers while the
 *  window is idle/occluded; calling this on window-wake means the first large
 *  message scrolled into view after idle doesn't pay a cold-worker round-trip
 *  (or hit the 3s watchdog → main-thread sync fallback). The echoed reply
 *  carries an id no waiter is registered for, so it's harmlessly ignored. */
export function warmMarkdownWorker(): void {
  // Same idea for the main-thread renderer: get its chunk resident before the
  // first small block wants a synchronous parse.
  void ensureRenderer();
  const w = ensureWorker();
  if (w) {
    try {
      w.postMessage({ id: -1, source: "" });
    } catch {
      /* ignore */
    }
  }
}

// ── Priority queue ─────────────────────────────────────────────────────────
//
// Blocks used to be posted to the worker the moment they mounted. The worker
// drains FIFO, and rows mount top-to-bottom, so the queue was strictly
// OLDEST-FIRST — the exact reverse of what the reader needs. Loading a session
// lands the viewport at the newest turns, and those were last in line behind
// every historical message, each one popping from placeholder to formatted as it
// arrived and reflowing everything below it. That is the "content pushing"
// during history load.
//
// So the queue is ours, not the worker's: hold the work here, keep only a couple
// of parses in flight, and always dispatch the highest priority next. Callers
// pass the row's position, so the newest visible message is parsed first and the
// reader's viewport settles before anything off-screen is touched.

interface QueueItem {
  source: string;
  priority: number;
  dispatch: () => void;
}

const queue: QueueItem[] = [];
let inFlight = 0;
/** Small, not 1: one keeps the worker idle for a round-trip between items, and
 *  much more would let a burst of low-priority work overtake a late arrival. */
const MAX_IN_FLIGHT = 2;

function pump(): void {
  while (inFlight < MAX_IN_FLIGHT && queue.length > 0) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].priority > queue[best].priority) best = i;
    }
    const item = queue.splice(best, 1)[0];
    inFlight += 1;
    item.dispatch();
  }
}

/** Raise a queued item's priority — the same source can be requested again by a
 *  row that matters more (e.g. it scrolled into view). */
function bumpPriority(source: string, priority: number): void {
  for (const item of queue) {
    if (item.source === source && priority > item.priority) item.priority = priority;
  }
}

/** Parse a large block off the main thread. Falls back to a gated-idle main-
 *  thread parse (the pre-worker behavior) if the worker is unavailable.
 *  `priority` orders the queue — higher goes first. */
function parseLarge(source: string, priority: number): Promise<string> {
  const hit = cacheGet(source);
  if (hit !== undefined) return Promise.resolve(hit);
  const existing = pending.get(source);
  if (existing) {
    bumpPriority(source, priority);
    return existing;
  }

  const w = ensureWorker();
  let p: Promise<string>;
  if (w) {
    p = new Promise<string>((resolve) => {
      const id = ++seq;
      let settled = false;
      const finish = (html: string) => {
        if (settled) return;
        settled = true;
        waiters.delete(id);
        cacheSet(source, html);
        inFlight = Math.max(0, inFlight - 1);
        resolve(html);
        // Free slot — start the next-highest-priority block.
        pump();
      };
      queue.push({
        source,
        priority,
        dispatch: () => {
          waiters.set(id, { source, finish });
          // Watchdog: if the worker never answers (e.g. its script failed to
          // load asynchronously), fall back to a main-thread parse so the
          // message still renders instead of hanging blank.
          window.setTimeout(() => {
            if (!settled) {
              workerBroken = true;
              void renderToHtmlAsync(source).then(finish);
            }
          }, 3000);
          w.postMessage({ id, source });
        },
      });
      pump();
    });
  } else {
    // Fallback: parse on the main thread but keep it out of typing bursts.
    p = new Promise<string>((resolve) => {
      const startedAt = performance.now();
      const w2 = window as Window & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      };
      const schedule = () =>
        typeof w2.requestIdleCallback === "function"
          ? w2.requestIdleCallback(run, { timeout: 250 })
          : window.setTimeout(run, 32);
      function run() {
        if (isTypingHot() && performance.now() - startedAt < 2500) {
          schedule();
          return;
        }
        void renderToHtmlAsync(source).then(resolve);
      }
      schedule();
    });
  }
  pending.set(
    source,
    p.then((html) => {
      pending.delete(source);
      return html;
    }),
  );
  return pending.get(source)!;
}

interface CachedMarkdownProps {
  source: string;
  className?: string;
  /**
   * Drop the default `prose-chat` typography classes and style the output
   * purely from `className`.
   *
   * The new transcript needs this: its heights are PREDICTED from the metrics
   * pinned in `.atlas-prose`, and `prose-chat`'s element rules (`.prose-chat p`,
   * specificity 0,1,1) would win over `.atlas-prose > *` (0,1,0) and silently
   * change the real margins out from under the prediction. Opting out is
   * cleaner than escalating specificity in a fight the two stylesheets would
   * keep having.
   */
  unstyled?: boolean;
  /**
   * Parse-queue priority — higher parses sooner. Callers pass the row's position
   * in the thread, so the newest messages (the ones on screen after a history
   * load) format first and the viewport stops reflowing before off-screen work
   * begins. Only affects blocks large enough to go to the worker.
   */
  priority?: number;
}

/**
 * Drop-in replacement for `<Markdown>` in the chat thread. Renders the
 * cached HTML via `dangerouslySetInnerHTML`, so scroll-back remounts
 * don't re-parse markdown or re-run highlight.js. Large strings defer
 * the first parse to a `requestIdleCallback` so initial mount paint
 * isn't blocked; subsequent remounts hit the cache and skip the deferral.
 */
export function CachedMarkdown({
  source,
  className,
  unstyled,
  priority = 0,
}: CachedMarkdownProps) {
  const [html, setHtml] = useState<string | null>(() => {
    const hit = cacheGet(source);
    if (hit !== undefined) return hit;
    // Small blocks parse synchronously (cheap, no flash); large blocks defer
    // to the worker via the effect below. A small block ALSO defers when the
    // renderer chunk hasn't loaded yet — the effect routes it to the worker,
    // which carries its own copy of the pipeline and needs nothing from here.
    if (source.length <= SYNC_LIMIT) return renderToHtmlSyncIfReady(source);
    return null;
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hit = cacheGet(source);
    if (hit !== undefined) {
      if (hit !== html) setHtml(hit);
      return;
    }
    if (source.length <= SYNC_LIMIT) {
      const fresh = renderToHtmlSyncIfReady(source);
      if (fresh !== null) {
        if (fresh !== html) setHtml(fresh);
        return;
      }
      // Renderer chunk still loading — fall through to the worker path.
    }
    // Large block (or a small one before the renderer lands) → parse off the
    // main thread, then swap in the HTML.
    let cancelled = false;
    void parseLarge(source, priority).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
    // `html` intentionally omitted: re-running on our own setHtml would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, priority]);

  // One delegated click handler: copy-code buttons + safe external links.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // Copy-code button (injected below).
      const copyBtn = target?.closest?.(".atlas-code-copy");
      if (copyBtn instanceof HTMLElement) {
        e.preventDefault();
        const pre = copyBtn.closest("pre");
        const text = pre?.querySelector("code")?.textContent ?? pre?.textContent ?? "";
        void navigator.clipboard.writeText(text).catch(() => {});
        copyBtn.textContent = "Copied";
        window.setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 1200);
        return;
      }
      // External links: open in the system browser via the opener plugin
      // rather than letting an `<a>` navigate the WKWebView away from Atlas.
      const anchor = target?.closest?.("a");
      if (anchor instanceof HTMLAnchorElement && anchor.href && /^https?:/i.test(anchor.href)) {
        e.preventDefault();
        const href = anchor.href;
        void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href)).catch(() => {});
      }
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, []);

  // Inject a language label + copy button into each code block once the
  // cached HTML lands (and again whenever it changes).
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.querySelectorAll("pre").forEach((pre) => {
      if ((pre as HTMLElement).dataset.enhanced) return;
      (pre as HTMLElement).dataset.enhanced = "1";
      const code = pre.querySelector("code");
      const lang = Array.from(code?.classList ?? [])
        .find((c) => c.startsWith("language-"))
        ?.slice("language-".length);
      const bar = document.createElement("div");
      bar.className = "atlas-code-bar";
      if (lang && lang !== "text" && lang !== "plaintext") {
        const l = document.createElement("span");
        l.className = "atlas-code-lang";
        l.textContent = lang;
        bar.appendChild(l);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "atlas-code-copy";
      btn.setAttribute("aria-label", "Copy code");
      btn.textContent = "Copy";
      bar.appendChild(btn);
      pre.appendChild(bar);
    });
  }, [html]);

  const cls = cn(
    unstyled
      ? "select-text"
      : "prose-chat text-[var(--text-primary)] leading-relaxed break-words select-text",
    className,
  );

  // Not yet parsed (a large block waiting on the worker) — render the RAW
  // SOURCE rather than nothing.
  //
  // This matters far more than it looks. Rendering `__html: ""` gives an empty
  // element of ZERO height, so a screen's worth of unparsed messages collapses
  // the document to nothing; in the windowed transcript that showed up as the
  // whole viewport going blank at the moment the window grew, and it persisted
  // until the worker replied — up to the 3s watchdog if the worker was cold.
  //
  // The placeholder is the same text at the same size, so the height is about
  // right and the reader can read it immediately; it swaps to formatted HTML
  // when the parse lands. Unformatted beats absent, exactly as with rows.
  if (html === null) {
    return (
      <div ref={ref} className={cls}>
        <pre className="atlas-md-pending">{source}</pre>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={cls}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
