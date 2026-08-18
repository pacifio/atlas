import { memo, useEffect, useRef, useState, useMemo } from "react";
import {
  CachedMarkdown,
  parseTransientOffThread,
  transientWorkerAvailable,
} from "@/lib/markdown-cache";
import { parseMarkdown } from "@/lib/markdown-render";
import {
  splitTopLevelBlocks,
  hasReferenceDefinitions,
  isIncompleteCodeFence,
} from "@/lib/markdown-blocks";
import { cn } from "@/lib/utils";

/**
 * Block-level markdown renderer for the chat thread. Splits the message into
 * top-level blocks and renders each through the source-keyed `CachedMarkdown`
 * cache, so completed blocks are pure cache hits (never re-parsed) and only the
 * trailing (still-streaming) block re-parses per frame. This is the webview
 * translation of Zed's per-line layout cache / Open WebUI's per-block tokens:
 * markdown formats LIVE as it streams, with bounded re-work.
 *
 * Uses `display:contents` on each block wrapper so the N per-block `CachedMarkdown`
 * containers vanish from layout and their block elements remain layout-siblings
 * inside one formatting context — preserving prose margin-collapse / vertical
 * rhythm identical to the old single-container render.
 */

/** Below this length the live tail parses inline on every frame (sub-ms, and
 *  the per-frame cadence is what makes text format as it streams). Above it,
 *  parses are throttled — a long block's growth is mostly invisible mid-word
 *  anyway. Mirrors `SYNC_LIMIT` in markdown-cache. */
const INLINE_PARSE_LIMIT = 2000;
/** Parse cadence for a large live tail. */
const TRANSIENT_THROTTLE_MS = 120;

/**
 * Renderer for the STREAMING TAIL only — deliberately bypasses `CachedMarkdown`.
 *
 * The tail's source is a new unique string every applied frame, which made the
 * cached path pathological twice over: small tails wrote a partial into the LRU
 * per frame (evicting the settled blocks the cache exists to protect — the
 * scroll-back re-parse the cache was built to prevent), and large tails queued a
 * NEW worker parse per frame with no cancellation of superseded sources — a
 * ten-second paragraph enqueued hundreds of dead parses drained two at a time,
 * while the visible tail lagged the stale queue. A string that will never be
 * requested again must never touch the cache or the queue.
 *
 * The block re-renders as `CachedMarkdown` the moment it settles, which parses
 * and caches the final text once.
 */
const TransientMarkdown = memo(function TransientMarkdown({
  source,
  className,
  unstyled,
}: {
  source: string;
  className?: string;
  unstyled?: boolean;
}) {
  const small = source.length <= INLINE_PARSE_LIMIT;
  const inline = useMemo(() => (small ? parseMarkdown(source) : null), [small, source]);

  // Large tail: throttled trailing-edge parse of the LATEST source. The parse
  // itself runs on the markdown worker via the transient lane (single slot,
  // latest-wins, no cache/queue) — synchronously it was O(tail length) of
  // unified/rehype work on the main thread every 120ms, growing multi-frame
  // late in a long block, exactly while rAF delta flushes were running. The
  // sync parse remains only as the no-worker fallback.
  const [big, setBig] = useState("");
  const latest = useRef(source);
  latest.current = source;
  const timer = useRef<number | null>(null);
  const lastRun = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    if (small || timer.current !== null) return;
    const due = Math.max(0, TRANSIENT_THROTTLE_MS - (performance.now() - lastRun.current));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      lastRun.current = performance.now();
      if (transientWorkerAvailable()) {
        void parseTransientOffThread(latest.current).then((html) => {
          // null/"" = superseded or timed out — skip the tick; a newer parse
          // is on the way (and settling re-renders through CachedMarkdown).
          if (alive.current && html) setBig(html);
        });
      } else {
        setBig(parseMarkdown(latest.current));
      }
    }, due);
  }, [small, source]);
  useEffect(
    () => () => {
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  // Crossing the small→large boundary leaves `big` one throttle tick behind;
  // hold the last rendered html rather than flashing blank for that tick.
  const lastHtml = useRef("");
  const html = inline ?? (big || lastHtml.current);
  lastHtml.current = html;

  // Same external-link interception as CachedMarkdown — a click on a link in
  // the live tail must not navigate the WKWebView away from Atlas. (Copy-code
  // bars are skipped: fences render as plain text until they close, and the
  // settled block gets them from CachedMarkdown.)
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.("a");
      if (anchor instanceof HTMLAnchorElement && anchor.href && /^https?:/i.test(anchor.href)) {
        e.preventDefault();
        const href = anchor.href;
        void import("@tauri-apps/plugin-opener").then((m) => m.openUrl(href)).catch(() => {});
      }
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, []);

  return (
    <div
      ref={ref}
      className={cn(
        unstyled
          ? "select-text"
          : "prose-chat text-[var(--text-primary)] leading-relaxed break-words select-text",
        className,
      )}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

/** One top-level block. `trailing` = the last, still-streaming block. */
const MarkdownBlock = memo(function MarkdownBlock({
  source,
  trailing,
  className,
  unstyled,
  priority,
}: {
  source: string;
  trailing: boolean;
  className?: string;
  unstyled?: boolean;
  priority?: number;
}) {
  // A still-open code fence renders as plain text (no per-frame re-highlight of a
  // growing block); it snaps to highlighted once the closing fence streams in.
  if (trailing && isIncompleteCodeFence(source)) {
    return (
      <pre
        className={cn(
          "whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-[var(--text-primary)] select-text",
          className,
        )}
      >
        {source}
        <span className="atlas-stream-caret" aria-hidden />
      </pre>
    );
  }
  // The live tail bypasses the cache/worker entirely — see TransientMarkdown.
  if (trailing) {
    return (
      <TransientMarkdown
        source={source}
        unstyled={unstyled}
        className={cn("[display:contents]", className)}
      />
    );
  }
  return (
    <CachedMarkdown
      source={source}
      unstyled={unstyled}
      priority={priority}
      className={cn("[display:contents]", className)}
    />
  );
});

/** rAF-coalesced block split: at most one split per frame while streaming; a
 *  synchronous, memoized split when settled. */
function useBlocks(source: string, streaming: boolean, whole: boolean): string[] {
  const [blocks, setBlocks] = useState<string[]>(() =>
    whole ? [source] : splitTopLevelBlocks(source),
  );
  const rafRef = useRef<number | null>(null);
  const latest = useRef(source);
  latest.current = source;

  useEffect(() => {
    if (whole) return;
    if (!streaming) {
      // Settle: final split now; cancel any pending frame.
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setBlocks(splitTopLevelBlocks(source));
      return;
    }
    // Streaming: coalesce to one split per frame.
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setBlocks(splitTopLevelBlocks(latest.current));
    });
  }, [source, streaming, whole]);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return blocks;
}

export function StreamingMarkdown({
  source,
  streaming,
  className,
  unstyled,
  priority,
}: {
  source: string;
  streaming: boolean;
  className?: string;
  /** See `CachedMarkdown.unstyled` — the new transcript pins its own metrics. */
  unstyled?: boolean;
  /** See `CachedMarkdown.priority`. */
  priority?: number;
}) {
  // Reference-style link / footnote definitions need cross-block context, so
  // fall back to a single whole-message render — but only once SETTLED. During
  // streaming the definition may not have arrived yet anyway, so block-level is
  // fine there and avoids a per-frame whole-message re-parse. (Both rare in
  // agent output.)
  const hasRefs = useMemo(() => hasReferenceDefinitions(source), [source]);
  const renderWhole = hasRefs && !streaming;
  const blocks = useBlocks(source, streaming, renderWhole);

  if (renderWhole) {
    return (
      <CachedMarkdown
        source={source}
        unstyled={unstyled}
        priority={priority}
        className={className}
      />
    );
  }

  const lastIdx = blocks.length - 1;
  const trailingIsFence = streaming && lastIdx >= 0 && isIncompleteCodeFence(blocks[lastIdx]);

  return (
    <div className={className}>
      {blocks.map((blk, i) => (
        <MarkdownBlock
          key={i}
          source={blk}
          trailing={streaming && i === lastIdx}
          className={className}
          unstyled={unstyled}
          priority={priority}
        />
      ))}
      {/* Terminal-style caret after the last block while streaming — unless the
          trailing block is an open fence, which draws its own caret. */}
      {streaming && !trailingIsFence && <span className="atlas-stream-caret" aria-hidden />}
    </div>
  );
}
