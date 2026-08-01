// Helpers for splitting the "Atlas context" suffix the @-mention picker
// appends to user prose. Lives in /lib/ so both the chat-store
// (computing once on message insert) and the MessageItem renderer (as
// a fallback for legacy messages) can use the same split logic.

export const ATLAS_CONTEXT_MARKER = "\n\n---\n# Atlas context\n\n";

export interface SplitContext {
  prose: string;
  context: string | null;
  blockCount: number;
}

// Block labels that Atlas (Rust `agents_send`) injects into the wire prompt:
// shared cross-agent memory + retrieved long-term memory + recent-session recap.
// The coding agent echoes the received prompt into its transcript, so resumed
// sessions (esp. Codex, whose replay arrives via live deltas, not the JSONL the
// Rust reader strips) would otherwise show this scaffolding as the user message.
const INJECTED_CORES = [
  "SHARED MEMORY",
  "RELEVANT PROJECT MEMORY",
  "PROJECT MEMORY",
  "RECENT SESSION",
];

/** Strip Atlas-injected `--- LABEL ---` … `--- END LABEL ---` context blocks.
 *  Line-based and position-agnostic; mirrors the Rust `strip_injected_context`. */
export function stripInjectedContext(text: string): string {
  if (!text.includes("--- ")) return text; // fast path: no markers
  const out: string[] = [];
  let skipUntil: string | null = null;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (skipUntil !== null) {
      if (l === skipUntil) skipUntil = null;
      continue;
    }
    if (l.startsWith("--- ") && l.endsWith("---") && !l.startsWith("--- END")) {
      const core = INJECTED_CORES.find((c) => l.slice(4).startsWith(c));
      if (core) {
        skipUntil = `--- END ${core} ---`;
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Split a user message into (prose, contextBody, contextBlockCount).
 *  Returns `context: null` for messages without an Atlas-context
 *  suffix. Each block in the context starts with a `## ` heading
 *  (see `composePrompt`) so block count is a regex over the body. The prose is
 *  also cleaned of any injected shared-memory blocks so resumed sessions don't
 *  render the raw `--- SHARED MEMORY ---` scaffolding. */
export function splitAtlasContext(content: string): SplitContext {
  const idx = content.indexOf(ATLAS_CONTEXT_MARKER);
  if (idx === -1) {
    return {
      prose: stripInjectedContext(content),
      context: null,
      blockCount: 0,
    };
  }
  const prose = stripInjectedContext(content.slice(0, idx));
  const context = content
    .slice(idx + ATLAS_CONTEXT_MARKER.length)
    .replace(/\n+$/, "");
  if (context.length === 0) return { prose, context: null, blockCount: 0 };
  const matches = context.match(/^## /gm);
  return {
    prose,
    context,
    blockCount: matches ? matches.length : 0,
  };
}
