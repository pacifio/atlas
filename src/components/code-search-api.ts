import { invoke } from "@tauri-apps/api/core";

/**
 * The project search overlay's one call: `code_grep` in
 * `src-tauri/src/commands/code_server/mod.rs`, which runs the same
 * `atlas_search` engine as the agents' `grep` tool. Field names mirror
 * `CodeGrepResult` (serde camelCase).
 */
export interface CodeGrepMatch {
  /** Relative to the searched root, `/`-separated. */
  path: string;
  line: number;
  /** Clipped to 300 chars around the match. */
  text: string;
}

export interface CodeGrepResult {
  matches: CodeGrepMatch[];
  totalMatches: number;
  totalFiles: number;
  /** More matched than `matches` holds. */
  truncated: boolean;
  /** The 15 s deadline stopped the search. */
  partial: boolean;
}

/** The overlay's three switches; all off is a case-insensitive literal search. */
export interface CodeSearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** How many matching lines the overlay asks for. */
export const SEARCH_MAX_RESULTS = 100;

/** Search `root` for `query`. Rejects with the engine's message (e.g. a regex error). */
export function codeGrep(
  root: string,
  query: string,
  options: CodeSearchOptions,
): Promise<CodeGrepResult> {
  return invoke<CodeGrepResult>("code_grep", {
    path: root,
    query,
    regex: options.regex,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    maxResults: SEARCH_MAX_RESULTS,
  });
}
