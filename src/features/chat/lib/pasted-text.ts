// A large paste as a composer chip.
//
// Text over the large-paste limit (`isLargePaste`) does not go into the
// editor. It becomes a `pasted_text` chip holding the whole text; the prompt
// carries its `@paste:<id>` token, and the text itself travels beside the
// prose in `agents_send`'s `pastedTexts`. Rust then picks the form by what the
// agent advertised (`atlas-acp-thread::prompt::with_pasted_texts`): an
// embedded text resource for an agent with `promptCapabilities.embeddedContext`,
// a fenced text block for every other. Every agent receives the full text,
// and never as a link to a file it might not be able to read.

import type { MentionData, MentionPastedText } from "./mentions";

/** A chip for `text`. */
export function pastedTextMention(
  text: string,
  // Unique within a session's drafts; short because it is visible in the
  // prompt text (`@paste:<id>`).
  id: string = Math.random().toString(36).slice(2, 8),
): MentionPastedText {
  const lines = text.split("\n").length;
  return {
    kind: "pasted_text",
    id,
    displayName: `Pasted text · ${lines} lines`,
    lines,
    text,
  };
}

/** The paste as plain text, in the same shape Rust sends an agent without
 *  embedded context: a header naming it, then a fence the text cannot close. */
export function pasteAsText(paste: Pick<MentionPastedText, "id" | "text">): string {
  const lines = Math.max(1, paste.text.replace(/\n$/, "").split("\n").length);
  let longest = 0;
  for (const run of paste.text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `Pasted text (@paste:${paste.id}, ${lines} ${lines === 1 ? "line" : "lines"}):\n${fence}\n${paste.text}\n${fence}`;
}

/** For a path that carries plain text only (the send queue holds strings):
 *  each paste's text appended after the prose, so it is not reduced to a
 *  token nothing can resolve. */
export function withPastesInline(text: string, mentions: readonly MentionData[]): string {
  const pastes = mentions.filter((m): m is MentionPastedText => m.kind === "pasted_text");
  if (pastes.length === 0) return text;
  return [text, ...pastes.map(pasteAsText)].join("\n\n");
}

const BLOCK_HEADER = /\n\nPasted text \(@paste:([A-Za-z0-9_-]+), \d+ lines?\):\n(`{3,})\n/y;

/** The blocks `withPastesInline` appended, read from `at` to the end of
 *  `text`; null unless they run exactly to the end. */
function readBlocks(text: string, at: number): MentionPastedText[] | null {
  const pastes: MentionPastedText[] = [];
  let pos = at;
  while (pos < text.length) {
    BLOCK_HEADER.lastIndex = pos;
    const header = BLOCK_HEADER.exec(text);
    if (!header) return null;
    const [whole, id, fence] = header;
    const bodyStart = pos + whole.length;
    // The fence is longer than any backtick run in the paste, so the first
    // line holding exactly it closes the block.
    const close = text.indexOf(`\n${fence}`, bodyStart - 1);
    if (close < 0 || text[close + 1 + fence.length] === "`") return null;
    pastes.push(pastedTextMention(text.slice(bodyStart, close), id));
    pos = close + 1 + fence.length;
  }
  return pastes;
}

/**
 * The way back from `withPastesInline`: the prose, its `@paste:<id>` tokens
 * kept, and each inlined paste as a chip again. A queued message being edited
 * comes back through here, so a paste returns to the composer as its chip
 * instead of as however many lines of text it holds. Text whose tail is not
 * exactly such blocks is returned as it is.
 */
export function collapsePastes(text: string): { text: string; pastes: MentionPastedText[] } {
  for (let at = text.indexOf("\n\nPasted text (@paste:"); at >= 0;) {
    const pastes = readBlocks(text, at);
    if (pastes) return { text: text.slice(0, at), pastes };
    at = text.indexOf("\n\nPasted text (@paste:", at + 1);
  }
  return { text, pastes: [] };
}
