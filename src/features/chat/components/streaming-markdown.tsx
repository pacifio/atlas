import { memo, useEffect, useRef, useState, useMemo } from "react";
import { CachedMarkdown } from "@/lib/markdown-cache";
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

/** One top-level block. `trailing` = the last, still-streaming block. */
const MarkdownBlock = memo(function MarkdownBlock({
  source,
  trailing,
  className,
}: {
  source: string;
  trailing: boolean;
  className?: string;
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
  return (
    <CachedMarkdown
      source={source}
      className={cn("[display:contents]", className)}
    />
  );
});

/** rAF-coalesced block split: at most one split per frame while streaming; a
 *  synchronous, memoized split when settled. */
function useBlocks(
  source: string,
  streaming: boolean,
  whole: boolean,
): string[] {
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
}: {
  source: string;
  streaming: boolean;
  className?: string;
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
    return <CachedMarkdown source={source} className={className} />;
  }

  const lastIdx = blocks.length - 1;
  const trailingIsFence =
    streaming && lastIdx >= 0 && isIncompleteCodeFence(blocks[lastIdx]);

  return (
    <div className={className}>
      {blocks.map((blk, i) => (
        <MarkdownBlock
          key={i}
          source={blk}
          trailing={streaming && i === lastIdx}
          className={className}
        />
      ))}
      {/* Terminal-style caret after the last block while streaming — unless the
          trailing block is an open fence, which draws its own caret. */}
      {streaming && !trailingIsFence && (
        <span className="atlas-stream-caret" aria-hidden />
      )}
    </div>
  );
}
