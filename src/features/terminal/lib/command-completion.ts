// Pure token parsing + completion-apply for the terminal command input. No
// CodeMirror — operates purely on the textarea's `value` + caret offset.

export type TokenKind = "command" | "path";

export interface TokenInfo {
  /** `value.slice(start, caret)` — the word being completed. */
  token: string;
  start: number;
  caret: number;
  kind: TokenKind;
  /** For a path token: everything up to and including the last `/` (the
   *  directory part that stays fixed). Empty for a bare name. */
  dirPart: string;
  /** The basename being typed (token without `dirPart`). */
  prefix: string;
}

function isPathLike(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("~/") ||
    token === "~" ||
    token.includes("/")
  );
}

/**
 * Identify the token under the caret. Returns null when the caret is in the
 * middle of a word (next char is non-whitespace) — we only complete at a word's
 * end. A backslash-escaped space (`\ `) does NOT end the token.
 */
export function parseToken(value: string, caret: number): TokenInfo | null {
  // Only complete at the end of a token.
  if (caret < value.length && !/\s/.test(value[caret])) return null;

  // Walk back to the token start: stop at unescaped whitespace.
  let start = caret;
  while (start > 0) {
    const ch = value[start - 1];
    if (/\s/.test(ch)) {
      // Escaped space (preceded by an odd number of backslashes) stays in token.
      let bs = 0;
      let k = start - 2;
      while (k >= 0 && value[k] === "\\") {
        bs++;
        k--;
      }
      if (bs % 2 === 0) break;
    }
    start--;
  }

  const token = value.slice(start, caret);
  // Command position = first word of the line, or right after a pipe / && / ||
  // / ; separator. (Matching the trailing separator char covers all of them.)
  const before = value.slice(0, start).trimEnd();
  const commandPosition = before === "" || /[|&;]$/.test(before);
  const kind: TokenKind =
    commandPosition && !isPathLike(token) ? "command" : "path";

  const slash = token.lastIndexOf("/");
  const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
  const prefix = slash >= 0 ? token.slice(slash + 1) : token;

  return { token, start, caret, kind, dirPart, prefix };
}

/**
 * Build the new textarea value + caret after accepting a completion. `end`
 * overrides where the replaced token ends (defaults to `info.caret`) — used when
 * a Tab-cycle has already inserted a longer preview that must be replaced.
 */
export function applyCompletion(
  value: string,
  info: TokenInfo,
  name: string,
  isDir: boolean,
  end: number = info.caret,
): { next: string; caret: number; keepOpen: boolean } {
  const escaped = name.replace(/ /g, "\\ ");
  let replacement: string;
  let keepOpen = false;
  if (info.kind === "command") {
    replacement = `${escaped} `;
  } else {
    replacement = `${info.dirPart}${escaped}${isDir ? "/" : " "}`;
    keepOpen = isDir; // a directory: keep the picker open to drill in
  }
  const next = value.slice(0, info.start) + replacement + value.slice(end);
  return { next, caret: info.start + replacement.length, keepOpen };
}
