/**
 * Repair for the STREAMING TAIL only.
 *
 * A token stream cuts markdown mid-token, and the renderer faithfully shows the
 * cut: `**bol` is literal asterisks for a few frames, then the closing `**`
 * lands and the same words snap to bold; a half-typed `[label](htt` shows its
 * brackets and parens, then collapses into a link. Every one of those snaps is
 * a re-layout of the line the reader is currently reading — the "flicker" of a
 * streaming answer is mostly this, not repaint cost.
 *
 * So the tail is rendered from a REPAIRED copy: dangling inline markers are
 * either closed (so the text is already bold while the rest of the word
 * arrives) or dropped (a link's syntax stays hidden until it is complete).
 * Nothing here touches settled text — `StreamingMarkdown` re-renders a block
 * from its raw source the moment it stops being the tail, so the repair can
 * never end up in the cache or in what the reader keeps.
 *
 * The rules are the same ones Streamdown's `parseIncompleteMarkdown` applies,
 * kept in-repo because they have to run inside our own worker pipeline rather
 * than a react-markdown tree.
 */

/** Fence lines (``` / ~~~) in the block, used to detect an unclosed fence. */
const FENCE_LINE = /^[ \t]{0,3}(?:`{3,}|~{3,})/;

/** A complete inline code span — masked out before any counting. */
const CODE_SPAN = /(`+)(?:[^`]|(?!\1)`)*\1/g;

/** `- ` / `* ` / `+ ` at the start of a line: a bullet, not emphasis. */
const BULLET = /^[ \t]*[*+-][ \t]/;

/** Trailing run of markers the stream cut in half. Trimming it and then
 *  re-balancing is idempotent for a COMPLETE run (`**bold**` → `**bold` →
 *  `**bold**`), which is what lets one rule cover both cases. */
const TRAILING_MARKER = /(?:\*+|~+|`+)$/;

function countFenceLines(source: string): number {
  let n = 0;
  for (const line of source.split("\n")) if (FENCE_LINE.test(line)) n += 1;
  return n;
}

/** Replace complete code spans with same-length inert filler so their contents
 *  can't be mistaken for emphasis, while every offset stays valid. */
function maskCodeSpans(source: string): string {
  return source.replace(CODE_SPAN, (m) => "x".repeat(m.length));
}

/** Index of the last `[` that is still open — the start of a link or image the
 *  stream has not finished yet. `-1` when every bracket is resolved. */
function danglingLinkStart(source: string): number {
  const masked = maskCodeSpans(source);
  const open = masked.lastIndexOf("[");
  if (open < 0) return -1;
  if (open > 0 && masked[open - 1] === "\\") return -1;
  const rest = masked.slice(open);
  const close = rest.indexOf("]");
  if (close < 0) return open; // `[label…` — destination not started
  // `[label](dest…` — parenthesis opened, never closed.
  if (rest[close + 1] === "(" && !rest.slice(close + 1).includes(")")) return open;
  return -1;
}

/**
 * Return `source` with its half-finished inline markup made whole, ready to be
 * parsed as the live tail. Returns the input unchanged when there is nothing to
 * repair, so the common case allocates nothing.
 */
export function closeIncompleteMarkdown(source: string): string {
  if (!source) return source;
  // An unclosed fence swallows everything after it; the caller renders that
  // case as plain text, and "repairing" markers inside code would be wrong
  // regardless.
  if (countFenceLines(source) % 2 === 1) return source;

  let out = source;

  // 1. Hide a link/image whose syntax is still arriving. The `!` of an image
  //    goes with it, or the reader is left with a stray bang.
  const link = danglingLinkStart(out);
  if (link >= 0) out = out.slice(0, link > 0 && out[link - 1] === "!" ? link - 1 : link);

  // 2. Drop the marker run the stream cut in half, then close what is open.
  out = out.replace(TRAILING_MARKER, "");
  if (!out) return out;

  // 3. Inline code: any backtick surviving the mask opened a span. Close it
  //    FIRST and re-mask, or the span's own contents (`a * b`) get counted as
  //    dangling emphasis below.
  if (maskCodeSpans(out).includes("`")) out += "`";
  const masked = maskCodeSpans(out);

  // 4. Strikethrough (GFM), counted in pairs.
  let tildePairs = 0;
  for (const run of masked.match(/~+/g) ?? []) tildePairs += Math.floor(run.length / 2);
  if (tildePairs % 2 === 1) out += "~~";

  // 5. Emphasis. `_` is deliberately NOT balanced: snake_case identifiers are
  //    far more common in agent output than underscore italics, and closing a
  //    "dangling" underscore inside `some_name` would italicise real text.
  let doubles = 0;
  let singles = 0;
  for (const line of masked.split("\n")) {
    const body = line.replace(BULLET, "");
    for (const run of body.match(/\*+/g) ?? []) {
      doubles += Math.floor(run.length / 2);
      singles += run.length % 2;
    }
  }
  if (singles % 2 === 1) out += "*";
  if (doubles % 2 === 1) out += "**";

  return out;
}
