/**
 * Find over a file's plain text, for when the editor's own find panel cannot
 * open: a read-only large file, or before the workers' highlight lands and
 * the editor attaches. One pass of `indexOf`, counting lines as it goes, so a
 * file of tens of megabytes answers in milliseconds and nothing is split.
 */

/** Past this many matches the search stops; the count reads "N+". */
export const MAX_PLAIN_FIND_MATCHES = 10_000;

/** A match, 1-based, on one line: `column` up to (not including) `endColumn`. */
export interface PlainFindMatch {
  line: number;
  column: number;
  endColumn: number;
}

let lowered: { text: string; lower: string } | null = null;

/** `text` lower-cased, kept for the last text asked about: every keystroke
 *  of a case-insensitive search would otherwise copy the whole file again. */
function lowerOf(text: string): string {
  if (lowered?.text !== text) lowered = { text, lower: text.toLowerCase() };
  return lowered.lower;
}

/** Forget the lower-cased copy (a closed find bar should not pin a file). */
export function releasePlainFindCache(): void {
  lowered = null;
}

export function findInText(
  text: string,
  query: string,
  matchCase: boolean,
  max = MAX_PLAIN_FIND_MATCHES,
): PlainFindMatch[] {
  if (!query || query.includes("\n")) return [];
  // `toLowerCase` can change a string's length (e.g. "İ"); fall back to the
  // exact search then rather than report offsets into a different string.
  let haystack = text;
  let needle = query;
  if (!matchCase) {
    const lower = lowerOf(text);
    if (lower.length === text.length) {
      haystack = lower;
      needle = query.toLowerCase();
    }
  }
  const matches: PlainFindMatch[] = [];
  let line = 1;
  let lineStart = 0;
  let scanned = 0;
  for (
    let at = haystack.indexOf(needle);
    at !== -1 && matches.length < max;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    for (let nl = haystack.indexOf("\n", scanned); nl !== -1 && nl < at;) {
      line += 1;
      lineStart = nl + 1;
      nl = haystack.indexOf("\n", nl + 1);
    }
    scanned = at;
    const column = at - lineStart + 1;
    matches.push({ line, column, endColumn: column + needle.length });
  }
  return matches;
}

/** The first match at or after `line`, wrapping to the first; -1 for none. */
export function firstMatchAtOrAfter(matches: readonly PlainFindMatch[], line: number): number {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.line >= line);
  return i === -1 ? 0 : i;
}
