/**
 * The one line a thinking block shows while collapsed: what the agent is
 * thinking about right now, not just that it is thinking.
 *
 * Reasoning streams as markdown, often as a run of short sections that each
 * open with a bold heading ("**Checking the cache key**"). The newest section
 * is the current thought, so this reads the last heading on a line of its
 * own. Reasoning with no headings gives the first sentence of its last
 * paragraph instead. Inline markdown is stripped. Null when there is nothing
 * worth showing yet.
 *
 * It runs on the live thought every streaming frame, so it only ever strips
 * a bounded slice of text, and its patterns stay linear.
 */
export function thoughtHeadline(markdown: string): string | null {
  const headings = [...markdown.matchAll(/^[ \t]*\*\*([^*\r\n]+)\*\*[ \t]*$/gm)];
  if (headings.length > 0) {
    const heading = bounded(headings[headings.length - 1][1]);
    if (heading) return heading;
  }

  const paragraphs = markdown.split(/\r?\n\s*\r?\n/);
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const paragraph = paragraphs[i].trim();
    // A code block says nothing a reader can follow in one line.
    if (!paragraph || /^(```|~~~)/.test(paragraph)) continue;
    const text = bounded(paragraph);
    const end = SENTENCE_END.exec(text);
    // A paragraph just begun ("I") would replace a whole thought with a
    // fragment that then regrows a letter per chunk. Keep the previous
    // paragraph's line until this one has said something.
    if (!end && text.length < MIN_UNFINISHED && i > 0) continue;
    // `**` as a thought's first chunk cleans to nothing: no line yet.
    if (!text) continue;
    return end ? text.slice(0, end.index + end[0].length) : text;
  }
  return null;
}

/** How much of a paragraph is ever stripped: well past one line, and short
 *  enough that a 20k-character thought costs the same as a short one. */
const MAX_SCAN = 400;
/** Raw text read per heading or paragraph, before markdown is stripped. */
const RAW_SCAN = MAX_SCAN * 4;
const MIN_UNFINISHED = 24;
/** A sentence ends at `.`, `?` or `!` (and any closing quote or bracket)
 *  followed by space and something that is not a lowercase letter, so "e.g.
 *  the file" is not two sentences. */
const SENTENCE_END = /[.?!]["'”’)]?(?=\s+[^a-z\s]|\s*$)/;

/** Strip markdown from a wide raw window, then cut the result. Cutting first
 *  could split a link mid-URL and leave `[name](https://…` for `clean` to
 *  pass through; only a link longer than the whole window still can. */
function bounded(text: string): string {
  return clean(text.slice(0, RAW_SCAN)).slice(0, MAX_SCAN).trim();
}

function clean(text: string): string {
  return text
    .replace(/!?\[([^\][\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/** How much of the current thought the open live row ever shows: more than
 *  its four visible lines, so the newest text always fills them. */
const LIVE_TAIL = 600;

/**
 * The thought the agent is in the middle of, for the live row that shows it
 * open while it streams: the body of the newest bold-headed section (its
 * heading is the row's line, from `thoughtHeadline`), else the newest
 * paragraph. Only its tail, with inline markdown stripped — the row bottom-
 * aligns it, so the reader sees the words as they arrive. Null when there is
 * no body yet.
 */
export function liveThought(markdown: string): string | null {
  const headings = [...markdown.matchAll(/^[ \t]*\*\*([^*\r\n]+)\*\*[ \t]*$/gm)];
  const last = headings[headings.length - 1];
  let body = last ? markdown.slice((last.index ?? 0) + last[0].length) : markdown;
  if (!last) {
    const paragraphs = body.split(/\r?\n\s*\r?\n/).filter((p) => p.trim());
    // A paragraph just begun says less than the one before it.
    const tail = paragraphs[paragraphs.length - 1] ?? "";
    body =
      tail.trim().length < MIN_UNFINISHED && paragraphs.length > 1
        ? `${paragraphs[paragraphs.length - 2]}\n\n${tail}`
        : tail;
  }
  const text = clean(body.slice(-LIVE_TAIL * 2)).slice(-LIVE_TAIL);
  return text || null;
}
