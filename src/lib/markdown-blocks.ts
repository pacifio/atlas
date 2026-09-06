// Block-level splitting for streaming markdown. Parse the source to an mdast
// (parse only — no rehype/highlight/sanitize, so it's cheap + linear) and slice
// it into its top-level blocks by source offset. A completed block's slice is
// byte-identical every frame, so rendering each block through the source-keyed
// `CachedMarkdown` cache makes completed blocks pure cache hits — only the
// trailing (still-streaming) block re-parses. Mirrors Zed's `root_block_starts`
// and Open WebUI's per-block-token rendering.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

type OffsetNode = {
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

function buildParser() {
  return unified().use(remarkParse).use(remarkGfm);
}
let parser: ReturnType<typeof buildParser> | null = null;
function getBlockParser(): ReturnType<typeof buildParser> {
  if (!parser) parser = buildParser();
  return parser;
}

/**
 * Split a markdown source into its top-level block source strings. Returns
 * `[source]` (a single block) when there's nothing to split or on any parse
 * error — the caller renders that one block as a whole, which is always safe.
 */
export function splitTopLevelBlocks(source: string): string[] {
  return splitBlocks(source).blocks;
}

const REF_DEF = /^\s{0,3}\[[^\]]+\]:\s/m;
const FOOTNOTE_DEF = /^\s{0,3}\[\^[^\]]+\]:\s/m;

/**
 * True when the source uses reference-style link/image or footnote
 * *definitions* — the one case where independent per-block parsing loses
 * cross-block context. The caller falls back to a whole-message render. Rare in
 * agent output.
 */
export function hasReferenceDefinitions(source: string): boolean {
  return REF_DEF.test(source) || FOOTNOTE_DEF.test(source);
}

/**
 * True when `block` opens a fenced code block that hasn't been closed yet — the
 * still-streaming trailing code block. Render it as plain text until the fence
 * closes so a growing code block doesn't re-highlight every frame (it snaps to
 * highlighted once complete).
 */
export function isIncompleteCodeFence(block: string): boolean {
  const lines = block.split("\n");
  const first = (lines[0] ?? "").trimStart();
  const open = first.match(/^(`{3,}|~{3,})/);
  if (!open) return false;
  const fenceChar = open[1][0]; // ` or ~ (both are literal in regex)
  const minLen = open[1].length;
  const closeRe = new RegExp(`^\\s{0,3}${fenceChar}{${minLen},}\\s*$`);
  for (let i = 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) return false; // found the closing fence
  }
  return true; // opened, never closed
}

/** A split plus the offset the LAST block starts at, so a streaming caller can
 *  grow the tail (`source.slice(tailStart)`) without re-parsing. */
export interface BlockSplit {
  blocks: string[];
  /** Offset in `source` where the trailing block begins. */
  tailStart: number;
}

/**
 * `splitTopLevelBlocks` plus the trailing block's start offset.
 *
 * The offset is what makes incremental splitting possible: while the tail is
 * only growing, the caller rebuilds the last block as `source.slice(tailStart)`
 * — a substring — instead of re-parsing the whole message every frame. See
 * `mayStartNewBlock` for when a re-split is actually needed.
 */
export function splitBlocks(source: string): BlockSplit {
  if (!source) return { blocks: [], tailStart: 0 };
  try {
    const tree = getBlockParser().parse(source) as { children?: OffsetNode[] };
    const children = tree.children ?? [];
    if (children.length <= 1) return { blocks: [source], tailStart: 0 };
    const blocks: string[] = [];
    let tailStart = 0;
    for (const child of children) {
      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      if (start == null || end == null) continue;
      const block = source.slice(start, end);
      if (block.trim().length === 0) continue;
      blocks.push(block);
      tailStart = start;
    }
    return blocks.length > 0 ? { blocks, tailStart } : { blocks: [source], tailStart: 0 };
  } catch {
    return { blocks: [source], tailStart: 0 };
  }
}

/**
 * A new top-level block can only ever start at the beginning of a LINE, so a
 * delta with no line start that looks structural cannot have changed the block
 * boundaries — the trailing block simply got longer.
 *
 * Deliberately over-eager (a line starting with a digit or a dash re-splits
 * even when it stays inside the same paragraph): being wrong in that direction
 * costs one parse, and being wrong in the other direction costs nothing at all
 * visually — the trailing block is rendered by parsing it as markdown, so a
 * tail that briefly holds two blocks looks identical. Only cache granularity
 * depends on getting this right.
 */
const BLOCK_START_RE = /\n[ \t]*(?:[#>*+\-=|~`_]|\d+[.)]|$)/;
/** Inside an unclosed fence NOTHING starts a block until the fence closes. */
const FENCE_LINE_RE = /(?:^|\n)[ \t]{0,3}(?:```|~~~)/;

export function mayStartNewBlock(delta: string, tailIsOpenFence: boolean): boolean {
  if (!delta) return false;
  return tailIsOpenFence ? FENCE_LINE_RE.test(delta) : BLOCK_START_RE.test(delta);
}
