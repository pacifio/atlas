import { memo, useEffect, useLayoutEffect, useRef, useState, useMemo } from "react";
import { CachedMarkdown, noteTailHtml } from "@/lib/markdown-cache";
import { parseMarkdownStreaming } from "@/lib/markdown-render";
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
 * Four rules keep the live edge honest, and all four matter:
 *
 *  0. **The tail parses synchronously, every frame, with nothing in the way.**
 *     No throttle, no queue, no worker, no state the renderer can get stuck
 *     in. Everything else here exists to make that affordable — the tail is
 *     one block, and it is parsed without syntax highlighting.
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

/**
 * Hard ceiling on the live tail.
 *
 * Above it the tail renders as plain text until it settles — the same
 * degradation an unclosed code fence already gets. A ceiling, NOT a throttle: a
 * single top-level block this large is pathological, and text that keeps
 * arriving unformatted is strictly better than formatted text that stops
 * arriving.
 *
 * The design this replaces demoted an expensive tail to a 120 ms off-thread
 * lane and latched that demotion for the life of the block. That is what froze
 * answers mid-sentence: one slow parse — the FIRST one, before the pipeline is
 * warm — and the block never rendered live again, so the reader watched four
 * words and a blinking caret until the turn ended and the settled render
 * dumped the whole answer at once. A renderer must not have a state it cannot
 * leave, and the live tail must not depend on anything asynchronous.
 *
 * 6 KB is set from measurement: the stream pipeline costs roughly 2 ms per KB
 * (a typical tail block — one paragraph — is well under 1 ms), so this keeps
 * the per-frame parse inside a frame's budget with room to spare, while
 * sitting far above any ordinary paragraph, list or table.
 */
const STREAM_PLAIN_LIMIT = 6000;

/** Longest the incremental split may run without a real re-parse. A backstop,
 *  not the mechanism — `mayStartNewBlock` catches boundaries as they arrive. */
const RESPLIT_MAX_MS = 500;

/**
 * Renderer for the STREAMING TAIL only — deliberately bypasses `CachedMarkdown`.
 *
 * The tail's source is a new unique string every applied frame, which made the
 * cached path pathological: every frame wrote a partial into the LRU, evicting
 * the settled blocks the cache exists to protect. A string that will never be
 * requested again must never touch the cache.
 *
 * So it parses here, synchronously, on every frame — and that is the whole
 * design. It is affordable because of what it is NOT parsing: the tail is ONE
 * top-level block (settled blocks are cached and never re-touched), and the
 * stream pipeline skips syntax highlighting, which is the expensive half. What
 * remains is a few hundred bytes of remark on most frames.
 *
 * Nothing here is throttled, queued, or deferred to a worker. Every one of
 * those is a way for the live edge to fall behind the text, and the live edge
 * falling behind the text is the only bug the reader ever notices.
 *
 * The block re-renders as `CachedMarkdown` the moment it settles, which parses
 * and caches the final text once, with highlighting — and shows this
 * renderer's last html (`noteTailHtml`) in the meantime, so the swap is
 * invisible.
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
  const html = useMemo(() => parseMarkdownStreaming(repaired), [repaired]);

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

/**
 * The tail as plain text — an unclosed fence, or a block past the ceiling.
 *
 * `mono` for a fence, because that IS code and it snaps to a highlighted block
 * the moment the fence closes. Prose font otherwise: an oversized block is a
 * wall of prose, and setting it in monospace would make the switch at settle a
 * far bigger visual jump than the markdown markers it briefly shows.
 */
function PlainTail({
  source,
  className,
  mono,
}: {
  source: string;
  className?: string;
  mono: boolean;
}) {
  return (
    <pre
      className={cn(
        "whitespace-pre-wrap break-words select-text text-[var(--text-primary)]",
        mono ? "font-mono text-[13px] leading-relaxed" : "atlas-md-pending",
        className,
      )}
    >
      {source}
      <span className="atlas-stream-caret" aria-hidden />
    </pre>
  );
}

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
  // A still-open code fence renders as plain text (no per-frame re-highlight of
  // a growing block); it snaps to highlighted once the closing fence streams
  // in. Same for a tail past the ceiling — see `STREAM_PLAIN_LIMIT`.
  const openFence = trailing && isIncompleteCodeFence(source);
  if (trailing && (openFence || source.length > STREAM_PLAIN_LIMIT)) {
    return <PlainTail source={source} className={className} mono={openFence} />;
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
