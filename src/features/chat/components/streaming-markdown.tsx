import { memo, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import {
  CachedMarkdown,
  noteTailHtml,
  parseTransientOffThread,
  transientWorkerAvailable,
} from "@/lib/markdown-cache";
import { parseMarkdown } from "@/lib/markdown-render";
import {
  splitBlocks,
  mayStartNewBlock,
  hasReferenceDefinitions,
  isIncompleteCodeFence,
  type BlockSplit,
} from "@/lib/markdown-blocks";
import { closeIncompleteMarkdown } from "@/lib/markdown-stream";
import { applyHtml } from "@/lib/dom-html";
import { cn } from "@/lib/utils";

/**
 * Block-level markdown renderer for the chat thread. Splits the message into
 * top-level blocks and renders each through the source-keyed `CachedMarkdown`
 * cache, so completed blocks are pure cache hits (never re-parsed) and only the
 * trailing (still-streaming) block re-parses per frame. This is the webview
 * translation of Zed's per-line layout cache / Open WebUI's per-block tokens:
 * markdown formats LIVE as it streams, with bounded re-work.
 *
 * Three rules keep the live edge from flickering, and all three matter:
 *
 *  1. **The tail is repaired before it is parsed** (`closeIncompleteMarkdown`).
 *     A stream cuts markdown mid-token, so `**bol` is literal asterisks for a
 *     few frames and then the words snap to bold. Closing the dangling marker
 *     means the text is already bold while the rest of it arrives.
 *  2. **The tail is PATCHED, not replaced** (`applyHtml`). Re-setting
 *     `innerHTML` every frame destroys the nodes the reader is looking at:
 *     selection is dropped, hover resets, and WebKit repaints the whole block
 *     instead of the one line that changed.
 *  3. **The split is incremental.** Re-parsing the whole message to find block
 *     boundaries on every frame made per-frame cost scale with the length of
 *     the answer; while the tail only grows, it is a substring.
 *
 * Each block wrapper is `.atlas-md-block` (`display: contents`) so the N
 * per-block containers vanish from layout and their block elements remain
 * layout-siblings inside one formatting context — preserving prose
 * margin-collapse / vertical rhythm identical to a single-container render.
 */

/** Below this length the live tail parses inline on every frame (sub-ms, and
 *  the per-frame cadence is what makes text format as it streams). Above it,
 *  parses are throttled — a long block's growth is mostly invisible mid-word
 *  anyway. Mirrors `SYNC_LIMIT` in markdown-cache. */
const INLINE_PARSE_LIMIT = 2000;
/** Parse cadence for a large live tail. */
const TRANSIENT_THROTTLE_MS = 120;
/** A per-frame inline parse that costs more than this has outgrown the inline
 *  path regardless of length (a table, a dense list), so the block is demoted
 *  to the throttled off-thread lane for the rest of its life. Length alone was
 *  the wrong proxy: 1.5 KB of table markup is an order of magnitude more work
 *  than 1.5 KB of prose. */
const INLINE_BUDGET_MS = 6;
/** Longest the incremental split may run without a real re-parse. A backstop,
 *  not the mechanism — `mayStartNewBlock` catches boundaries as they arrive. */
const RESPLIT_MAX_MS = 500;

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
 * and caches the final text once — and shows this renderer's last html
 * (`noteTailHtml`) in the meantime, so the swap is invisible.
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
  // Parse the REPAIRED copy; everything downstream still keys off the raw
  // source, which is what the settled block will be rendered from.
  const repaired = useMemo(() => closeIncompleteMarkdown(source), [source]);

  const overBudget = useRef(false);
  const small = repaired.length <= INLINE_PARSE_LIMIT && !overBudget.current;
  const inline = useMemo(() => {
    if (!small) return null;
    const started = performance.now();
    const html = parseMarkdown(repaired);
    if (performance.now() - started > INLINE_BUDGET_MS) overBudget.current = true;
    return html;
  }, [small, repaired]);

  // Large tail: throttled trailing-edge parse of the LATEST source. The parse
  // itself runs on the markdown worker via the transient lane (single slot,
  // latest-wins, no cache/queue) — synchronously it was O(tail length) of
  // unified/rehype work on the main thread every 120ms, growing multi-frame
  // late in a long block, exactly while rAF delta flushes were running. The
  // sync parse remains only as the no-worker fallback.
  const [big, setBig] = useState("");
  const latest = useRef(repaired);
  latest.current = repaired;
  const timer = useRef<number | null>(null);
  const lastRun = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    // Set on every run, not once at mount: React re-runs effects on the same
    // instance (StrictMode's mount/unmount/mount in development), and a latch
    // that only ever went false left the throttled path permanently mute —
    // large blocks stopped updating mid-answer and only caught up on settle.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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
  }, [small, repaired]);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  // Crossing the small→large boundary leaves `big` one throttle tick behind;
  // hold the last rendered html rather than flashing blank for that tick.
  const lastHtml = useRef("");
  const html = inline ?? (big || lastHtml.current);
  lastHtml.current = html;

  const ref = useRef<HTMLDivElement>(null);
  // Patch, don't replace — see `applyHtml`. This is what keeps a selection
  // inside a live answer alive and stops WebKit repainting the whole block
  // every frame.
  useLayoutEffect(() => {
    const node = ref.current;
    if (node) applyHtml(node, html);
  }, [html]);

  // Hand the settling block something formatted to show while it parses.
  // Keyed by the RAW source: that is what `CachedMarkdown` will ask with.
  useEffect(() => {
    if (html) noteTailHtml(source, html);
  }, [source, html]);

  // Same external-link interception as CachedMarkdown — a click on a link in
  // the live tail must not navigate the WKWebView away from Atlas. (Copy-code
  // bars are skipped: fences render as plain text until they close, and the
  // settled block gets them from CachedMarkdown.)
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
  // `atlas-stream-tail` is what draws the caret, inline at the end of the last
  // line rather than as a block of its own below it.
  if (trailing) {
    return (
      <TransientMarkdown
        source={source}
        unstyled={unstyled}
        className="atlas-md-block atlas-stream-tail"
      />
    );
  }
  return (
    <CachedMarkdown
      source={source}
      unstyled={unstyled}
      priority={priority}
      className="atlas-md-block"
    />
  );
});

/**
 * Block split for a growing source.
 *
 * Full re-splits cost a remark parse of the WHOLE message, and running one per
 * frame made the per-frame cost of streaming scale with the length of the
 * answer — a long turn got progressively jankier as it went. While the tail is
 * only being appended to, the split is a substring of the source instead
 * (`tailStart`), and a real re-parse happens only when the delta could actually
 * have opened a new block.
 *
 * Getting that condition wrong cannot break rendering: the trailing block is
 * rendered by parsing it as markdown, so a tail that briefly holds two blocks
 * looks identical — only cache granularity is affected, and the periodic
 * backstop re-split repairs even that.
 */
function useBlocks(source: string, streaming: boolean, whole: boolean): string[] {
  const [blocks, setBlocks] = useState<string[]>(() =>
    whole ? [source] : splitBlocks(source).blocks,
  );
  const rafRef = useRef<number | null>(null);
  const latest = useRef(source);
  latest.current = source;
  /** Last real split, and the source it was computed from. */
  const split = useRef<SplitState | null>(null);

  useEffect(() => {
    if (whole) return;
    if (!streaming) {
      // Settle: final split now; cancel any pending frame.
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const at = splitBlocks(source);
      split.current = { at, source, when: performance.now() };
      setBlocks(at.blocks);
      return;
    }
    // Streaming: coalesce to one update per frame.
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setBlocks(nextBlocks(split, latest.current));
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

interface SplitState {
  at: BlockSplit;
  /** The source `at` was computed from. */
  source: string;
  /** When the last REAL re-split ran — drives the backstop. */
  when: number;
}

/** One streaming step: grow the tail if nothing structural arrived, otherwise
 *  re-split. Mutates the `split` ref, which is the incremental state. */
function nextBlocks(split: { current: SplitState | null }, source: string): string[] {
  const prev = split.current;
  const grown =
    prev !== null && source.length >= prev.source.length && source.startsWith(prev.source);
  if (prev && grown) {
    const delta = source.slice(prev.source.length);
    const tail = prev.at.blocks[prev.at.blocks.length - 1] ?? "";
    const stale = performance.now() - prev.when > RESPLIT_MAX_MS;
    if (!stale && !mayStartNewBlock(delta, isIncompleteCodeFence(tail))) {
      // Pure append: rebuild only the trailing block, by slicing.
      const blocks = prev.at.blocks.slice(0, -1);
      blocks.push(source.slice(prev.at.tailStart));
      prev.at = { blocks, tailStart: prev.at.tailStart };
      prev.source = source;
      return blocks;
    }
  }
  const at = splitBlocks(source);
  split.current = { at, source, when: performance.now() };
  return at.blocks;
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
  //
  // Short-circuited on `streaming` rather than computed and then ignored: the
  // check is two regexes over the WHOLE message, and running them per frame put
  // the length of the answer back into the per-frame cost the block split just
  // took out of it.
  const renderWhole = useMemo(
    () => !streaming && hasReferenceDefinitions(source),
    [streaming, source],
  );
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
    </div>
  );
}
