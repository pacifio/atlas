// Pure, DOM-free lowlight tokenizer shared by the git-diff highlight worker
// (`diff-highlight.worker.ts`) and the synchronous main-thread fallback
// (`diff-highlight.ts`). Keeping the tokenize logic here — with no cache, no
// React, no DOM — means the worker and the fallback can never drift, mirroring
// how `markdown-render.ts` is shared by the markdown worker + its fallback.
//
// Per-line (not per-file) tokenization is intentional: the diff only carries
// individual lines. Lines inside a multi-line construct (block comment,
// multi-line string) may color slightly off — the accepted tradeoff for a
// cheap highlighter.

import { common, createLowlight } from "lowlight";
import type { Element, Root, RootContent } from "hast";

/** A flattened, renderable token: a run of text + its highlight.js class. */
export interface DiffToken {
  text: string;
  cls: string | null;
}

// Diff `language` display strings (from `getLanguage()` in diff.ts) → the
// highlight.js grammar ids registered in lowlight's `common` set. Anything not
// listed (or not in `common`) falls back to plain text.
const LANG_TO_HLJS: Record<string, string> = {
  TypeScript: "typescript",
  JavaScript: "javascript",
  Python: "python",
  Rust: "rust",
  Go: "go",
  Ruby: "ruby",
  Java: "java",
  C: "c",
  "C++": "cpp",
  CSS: "css",
  HTML: "xml",
  XML: "xml",
  JSON: "json",
  YAML: "yaml",
  Markdown: "markdown",
  Shell: "bash",
  SQL: "sql",
  TOML: "ini",
  Swift: "swift",
  Kotlin: "kotlin",
};

/** Resolve a diff display language to its highlight.js grammar id, or undefined
 *  when unsupported (caller should render raw text). */
export function hljsIdForLanguage(language: string): string | undefined {
  return LANG_TO_HLJS[language];
}

// Skip pathologically long lines (minified blobs, etc.) — not worth the
// tokenize cost and they never read as code anyway.
export const MAX_LEN = 2000;

// Built lazily on first tokenize so merely importing this module (e.g. for the
// language map) doesn't register ~35 grammars. In the normal path this runs in
// the worker thread; on the main thread it's only paid if the fallback fires.
let lowlightInstance: ReturnType<typeof createLowlight> | null = null;
function lowlight(): ReturnType<typeof createLowlight> {
  return (lowlightInstance ??= createLowlight(common));
}

/**
 * Tokenize a single line given a highlight.js grammar id. Returns the colored
 * token runs, or `null` when the id is empty, the line is empty/too long, or
 * highlighting produced nothing worth coloring — the caller renders raw text.
 */
export function tokenizeLine(
  hljsId: string,
  content: string,
): DiffToken[] | null {
  if (!hljsId || !content || content.length > MAX_LEN) return null;
  try {
    const tree = lowlight().highlight(hljsId, content) as Root;
    const tokens = flatten(tree.children, null);
    // Single unclassed run == nothing to highlight; let the caller fast-path to
    // plain text (and skip the wrapper class).
    if (
      tokens.length === 0 ||
      (tokens.length === 1 && tokens[0].cls === null)
    ) {
      return null;
    }
    return tokens;
  } catch {
    return null;
  }
}

/** Flatten the hast tree to a flat token list, carrying the nearest
 *  `hljs-*` class down to each text node. */
function flatten(nodes: RootContent[], inherited: string | null): DiffToken[] {
  const out: DiffToken[] = [];
  for (const node of nodes) {
    if (node.type === "text") {
      if (node.value) out.push({ text: node.value, cls: inherited });
    } else if (node.type === "element") {
      out.push(...flatten(node.children, classOf(node) ?? inherited));
    }
  }
  return out;
}

/** highlight.js emits `properties.className` as a string array, e.g.
 *  `["hljs-title", "function_"]`. Keep the full space-joined class so the CSS
 *  can target compound selectors like `.hljs-title.function_`. */
function classOf(el: Element): string | null {
  const cn = el.properties?.className;
  if (Array.isArray(cn) && cn.length) return cn.join(" ");
  if (typeof cn === "string" && cn) return cn;
  return null;
}
