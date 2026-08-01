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
import { parseMarkdown } from "./markdown-render";
import MarkdownWorker from "./markdown.worker?worker";
import "highlight.js/styles/github-dark.css";
import { cn } from "./utils";

const CACHE_MAX = 250;
// Insertion-ordered Map → simple LRU via delete+set on hit. Bounded so a
// thread of thousands of unique strings can't grow this unbounded.
const cache = new Map<string, string>();

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
  cache.set(src, html);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Synchronous parse on the main thread, with caching. Used for small blocks,
 *  cache misses already in hand, and the worker-unavailable fallback. */
function renderToHtmlSync(src: string): string {
  const cached = cacheGet(src);
  if (cached !== undefined) return cached;
  const html = parseMarkdown(src);
  cacheSet(src, html);
  return html;
}

// ── Off-thread parse client ────────────────────────────────────────────────

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const waiters = new Map<number, (html: string) => void>();
// Dedupe concurrent requests for the same source so two visible copies of an
// identical message don't parse twice.
const pending = new Map<string, Promise<string>>();

function ensureWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    worker = new MarkdownWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; html: string }>) => {
      const resolve = waiters.get(e.data.id);
      if (resolve) {
        waiters.delete(e.data.id);
        resolve(e.data.html);
      }
    };
    worker.onerror = () => {
      // Reject in-flight waiters back to the sync path and stop using the worker.
      workerBroken = true;
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
  const w = ensureWorker();
  if (w) {
    try {
      w.postMessage({ id: -1, source: "" });
    } catch {
      /* ignore */
    }
  }
}

/** Parse a large block off the main thread. Falls back to a gated-idle main-
 *  thread parse (the pre-worker behavior) if the worker is unavailable. */
function parseLarge(source: string): Promise<string> {
  const hit = cacheGet(source);
  if (hit !== undefined) return Promise.resolve(hit);
  const existing = pending.get(source);
  if (existing) return existing;

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
        resolve(html);
      };
      waiters.set(id, finish);
      // Watchdog: if the worker never answers (e.g. its script failed to load
      // asynchronously), fall back to a main-thread parse so the message still
      // renders instead of hanging blank.
      window.setTimeout(() => {
        if (!settled) {
          workerBroken = true;
          finish(renderToHtmlSync(source));
        }
      }, 3000);
      w.postMessage({ id, source });
    });
  } else {
    // Fallback: parse on the main thread but keep it out of typing bursts.
    p = new Promise<string>((resolve) => {
      const startedAt = performance.now();
      const w2 = window as Window & {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout?: number },
        ) => number;
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
        resolve(renderToHtmlSync(source));
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
}

/**
 * Drop-in replacement for `<Markdown>` in the chat thread. Renders the
 * cached HTML via `dangerouslySetInnerHTML`, so scroll-back remounts
 * don't re-parse markdown or re-run highlight.js. Large strings defer
 * the first parse to a `requestIdleCallback` so initial mount paint
 * isn't blocked; subsequent remounts hit the cache and skip the deferral.
 */
export function CachedMarkdown({ source, className }: CachedMarkdownProps) {
  const [html, setHtml] = useState<string | null>(() => {
    const hit = cacheGet(source);
    if (hit !== undefined) return hit;
    // Small blocks parse synchronously (cheap, no flash); large blocks defer
    // to the worker via the effect below.
    if (source.length <= SYNC_LIMIT) return renderToHtmlSync(source);
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
      const fresh = renderToHtmlSync(source);
      if (fresh !== html) setHtml(fresh);
      return;
    }
    // Large block → parse off the main thread, then swap in the HTML.
    let cancelled = false;
    void parseLarge(source).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
    // `html` intentionally omitted: re-running on our own setHtml would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

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
        const text =
          pre?.querySelector("code")?.textContent ?? pre?.textContent ?? "";
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
      if (
        anchor instanceof HTMLAnchorElement &&
        anchor.href &&
        /^https?:/i.test(anchor.href)
      ) {
        e.preventDefault();
        const href = anchor.href;
        void import("@tauri-apps/plugin-opener")
          .then((m) => m.openUrl(href))
          .catch(() => {});
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

  return (
    <div
      ref={ref}
      className={cn(
        "prose-chat text-[var(--text-primary)] leading-relaxed break-words select-text",
        className,
      )}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html ?? "" }}
    />
  );
}
