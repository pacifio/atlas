// A passage of an agent reply, cited back to the agent as a composer chip.
//
// Selecting text in a reply and choosing Cite makes a `cited_text` mention:
// the passage (capped), the user's optional note, the transcript message it
// came from and, on a session shared with the team, the captured row that
// message is. The prompt carries its `@cite:<id>` token where the chip sat,
// and `compose_prompt` (Rust) appends a block quoting the passage as from an
// earlier reply in this session, followed by the note.
//
// A cite is private to the agent. Sharing it with the team is a separate,
// opt-in comment (`cite-popover.tsx`), posted through the ordinary comment
// path; nothing here touches comments.
//
// Paths that carry plain text only — the send queue, and a send whose
// `compose_prompt` failed — get the cite written out after the prose
// (`withCitesInline`), the way `pasted-text.ts` inlines a paste, and a queued
// message being edited reads it back as its chip (`collapseCites`).

import type { MentionCitedText, MentionData } from "./mentions";

/**
 * The longest passage a cite carries, in characters, ellipsis included. A
 * cite points the agent at a few sentences or a snippet of its own reply; the
 * reply is already in the agent's context, so the quote only has to say which
 * part. Half the large-paste limit (`LARGE_PASTE_CHARS`, 4,000), so a cite is
 * never the size of a paste.
 */
export const CITE_MAX_CHARS = 2000;

/** How much of the passage the chip's label shows. */
const LABEL_CHARS = 32;

/**
 * `text` cut to at most `max` UTF-16 units, never through the middle of a
 * surrogate pair. Half an emoji is a lone surrogate, which serde rejects:
 * `compose_prompt` would fail to deserialize and the cite would be lost.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** `text` cut to `max` units including a trailing ellipsis. */
function cutWithEllipsis(text: string, max: number): string {
  return `${cutText(text, max - 1).trimEnd()}…`;
}

/** The passage as a cite keeps it: newlines normalised, blank edges trimmed,
 *  and cut to `CITE_MAX_CHARS` with an ellipsis. */
export function capCitation(text: string): { text: string; truncated: boolean } {
  const normalised = text.replace(/\r\n?/g, "\n").replace(/^\s*\n|\n\s*$/g, "");
  if (normalised.length <= CITE_MAX_CHARS) return { text: normalised, truncated: false };
  return { text: cutWithEllipsis(normalised, CITE_MAX_CHARS), truncated: true };
}

/** The chip's label: the start of the passage on one line, in quotes. */
export function citeLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.length > LABEL_CHARS ? cutWithEllipsis(flat, LABEL_CHARS) : flat;
  return `“${cut}”`;
}

/** A cite of `text` from `messageId`. The text is capped here, so every cite
 *  that exists is within `CITE_MAX_CHARS`. */
export function citedTextMention(
  source: { text: string; note?: string; messageId: string; rowId?: string | null },
  // Unique within a session's drafts; short because it is visible in the
  // prompt text (`@cite:<id>`).
  id: string = Math.random().toString(36).slice(2, 8),
): MentionCitedText {
  const { text } = capCitation(source.text);
  return {
    kind: "cited_text",
    id,
    displayName: citeLabel(text),
    messageId: source.messageId,
    rowId: source.rowId ?? null,
    text,
    // Capped like the passage: a note is a sentence or two, and the whole
    // cite rides in one prompt block.
    note: cutText((source.note ?? "").trim(), CITE_MAX_CHARS).trim(),
  };
}

/** A fence neither the passage nor the note can close. */
function fenceFor(...bodies: string[]): string {
  let longest = 0;
  for (const body of bodies) {
    for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** An id as the header writes it: nothing that could end the header early
 *  (`encodeURIComponent` leaves parentheses alone). */
function headerId(id: string): string {
  return encodeURIComponent(id).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** The cite as plain text: a header naming it and where it came from, the
 *  passage in a fence, then the note in the same fence when there is one. */
export function citeAsText(cite: MentionCitedText): string {
  const fence = fenceFor(cite.text, cite.note);
  const row = cite.rowId ? `, row ${headerId(cite.rowId)}` : "";
  const head =
    `Cited passage (@cite:${cite.id}, message ${headerId(cite.messageId)}${row}), ` +
    `from an earlier reply in this session:\n${fence}\n${cite.text}\n${fence}`;
  return cite.note ? `${head}\nNote:\n${fence}\n${cite.note}\n${fence}` : head;
}

/** Each cite written out after the prose, so a path that carries a string
 *  does not reduce it to a token nothing can resolve. */
export function withCitesInline(text: string, mentions: readonly MentionData[]): string {
  const cites = mentions.filter((m): m is MentionCitedText => m.kind === "cited_text");
  if (cites.length === 0) return text;
  return [text, ...cites.map(citeAsText)].join("\n\n");
}

const MARKER = "\n\nCited passage (@cite:";
const HEADER =
  /\n\nCited passage \(@cite:([A-Za-z0-9_-]+), message ([^\s,()]+)(?:, row ([^\s,()]+))?\), from an earlier reply in this session:\n(`{3,})\n/y;

/** The fenced body starting at `start`, closed by `fence`; null when it does
 *  not close. The fence is longer than any backtick run inside, so the first
 *  line holding exactly it closes the body. */
function fenced(text: string, start: number, fence: string): { body: string; end: number } | null {
  const close = text.indexOf(`\n${fence}`, start - 1);
  if (close < 0 || text[close + 1 + fence.length] === "`") return null;
  return { body: text.slice(start, Math.max(start, close)), end: close + 1 + fence.length };
}

/** The blocks `withCitesInline` wrote, from `at` to the end of `text`; null
 *  unless they run exactly to the end. */
function readBlocks(text: string, at: number): MentionCitedText[] | null {
  const cites: MentionCitedText[] = [];
  let pos = at;
  while (pos < text.length) {
    HEADER.lastIndex = pos;
    const header = HEADER.exec(text);
    if (!header) return null;
    const [whole, id, message, row, fence] = header;
    const quote = fenced(text, pos + whole.length, fence);
    if (!quote) return null;
    pos = quote.end;
    let note = "";
    const noteOpen = `\nNote:\n${fence}\n`;
    if (text.startsWith(noteOpen, pos)) {
      const body = fenced(text, pos + noteOpen.length, fence);
      if (!body) return null;
      note = body.body;
      pos = body.end;
    }
    cites.push(
      citedTextMention(
        {
          text: quote.body,
          note,
          messageId: decodeURIComponent(message),
          rowId: row ? decodeURIComponent(row) : null,
        },
        id,
      ),
    );
  }
  return cites;
}

/**
 * The way back from `withCitesInline`: the prose, its `@cite:<id>` tokens
 * kept, and each inlined cite as a chip again. Text whose tail is not exactly
 * such blocks is returned as it is.
 */
export function collapseCites(text: string): { text: string; cites: MentionCitedText[] } {
  for (let at = text.indexOf(MARKER); at >= 0; at = text.indexOf(MARKER, at + 1)) {
    try {
      const cites = readBlocks(text, at);
      if (cites) return { text: text.slice(0, at), cites };
    } catch {
      // A malformed escape in an id: not one of ours.
    }
  }
  return { text, cites: [] };
}
