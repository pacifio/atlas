// Helpers for splitting the "Atlas context" suffix the @-mention picker
// appends to user prose. Lives in /lib/ so both the chat-store
// (computing once on message insert) and the MessageItem renderer (as
// a fallback for legacy messages) can use the same split logic.

const ATLAS_CONTEXT_MARKER = "\n\n---\n# Atlas context\n\n";

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

/** One Atlas-injected context block, recovered rather than discarded. */
export interface InjectedBlock {
  /** The marker's label — `SHARED MEMORY`, `RELEVANT PROJECT MEMORY`, … */
  label: string;
  body: string;
}

/** Split Atlas-injected `--- LABEL ---` … `--- END LABEL ---` blocks out of a
 *  prompt, returning both halves. Line-based and position-agnostic; mirrors the
 *  Rust `strip_injected_context`.
 *
 *  The blocks are *kept* here because two callers want opposite things from the
 *  same parse: the chat renderer drops them (they are scaffolding the agent
 *  echoed back), while the Timeline's session detail renders them as their own
 *  cards — what Atlas contributed to a turn is a fact about the turn, and
 *  hiding it made every prompt look unassisted. One parser, so the two can
 *  never disagree about where a block ends. */
export function extractInjectedContext(text: string): {
  prose: string;
  blocks: InjectedBlock[];
} {
  if (!text.includes("--- ")) return { prose: text, blocks: [] }; // fast path
  const out: string[] = [];
  const blocks: InjectedBlock[] = [];
  let open: { label: string; end: string; lines: string[] } | null = null;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (open !== null) {
      if (l === open.end) {
        blocks.push({ label: open.label, body: open.lines.join("\n").trim() });
        open = null;
      } else {
        open.lines.push(line);
      }
      continue;
    }
    if (l.startsWith("--- ") && l.endsWith("---") && !l.startsWith("--- END")) {
      const core = INJECTED_CORES.find((c) => l.slice(4).startsWith(c));
      if (core) {
        open = { label: core, end: `--- END ${core} ---`, lines: [] };
        continue;
      }
    }
    out.push(line);
  }
  // An unterminated block is still a block — a truncated prompt preview cuts the
  // closing marker off long before it runs out of body.
  if (open) blocks.push({ label: open.label, body: open.lines.join("\n").trim() });
  return { prose: out.join("\n").trim(), blocks };
}

/** Strip Atlas-injected context blocks, keeping only the prose. */
export function stripInjectedContext(text: string): string {
  return extractInjectedContext(text).prose;
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
    return { prose: stripInjectedContext(content), context: null, blockCount: 0 };
  }
  const prose = stripInjectedContext(content.slice(0, idx));
  const context = content.slice(idx + ATLAS_CONTEXT_MARKER.length).replace(/\n+$/, "");
  if (context.length === 0) return { prose, context: null, blockCount: 0 };
  const matches = context.match(/^## /gm);
  return {
    prose,
    context,
    blockCount: matches ? matches.length : 0,
  };
}
