// Markdown flattened to one readable line, for the places that show a PREVIEW
// of a message rather than the message: the reply stub above a message, the
// composer's reply/edit strip, and the pinned list.
//
// Those surfaces used to print the body raw, so a reply to a formatted message
// quoted `**ship it** <@u_9f3a…>` — markers and internal user ids and all.
//
// Deliberately regex-based rather than the parser this feature just gained.
// The pinned popover filters up to `CHAT_PIN_LIMIT` rows on every keystroke,
// and parsing a hundred markdown documents per keypress is not a thing to do;
// pulling the markdown chunk into that popover would also undo the lazy
// boundary in `../components/message-body`. Every consumer is a one-line
// truncate or a two-line clamp, so losing structure is the point — this is not
// trying to be a renderer, and should never grow into one.

import { CHAT_BODY_MAX_BYTES, MENTION_SOURCE } from "../types";
import type { OrgMemberProfile } from "../types";

const FENCE = /```[^\n]*\n?([\s\S]*?)```/g;
const MENTION = new RegExp(MENTION_SOURCE, "g");
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK = /\[([^\]]*)\]\([^)]*\)/g;
const EMPHASIS = /(\*\*\*|___|\*\*|__|~~|`|\*|_)/g;
const LINE_PREFIX =
  /^[ \t]*(?:>[ \t]?|#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+)/gm;
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm;
const THEMATIC_BREAK = /^[ \t]*(?:\*{3,}|-{3,}|_{3,})[ \t]*$/gm;
const ESCAPE = /\\([\\`*_{}[\]()#+\-.!>~|])/g;
/* An escaped character is SHIFTED into the private-use area for the duration
   of the marker strips, then shifted back. A sentinel PREFIX would not work:
   the strips match a `*` wherever it sits, so the shielded character itself has
   to stop being a `*`. Everything markdown lets you escape is ASCII, so the
   window is small and cannot collide with anything a person typed. */
const SHIELD_BASE = 0xe000;
const SHIELDED = /[\ue000-\ue07f]/g;

/**
 * A one-line, marker-free rendering of `body`, with `<@id>` resolved to a name.
 *
 * `@channel` / `@here` are left as written — they already read as words.
 */
export function toPlainText(body: string, members: Map<string, OrgMemberProfile>): string {
  // A preview never needs more than the opening words, and the cap keeps the
  // scans below bounded regardless of what arrives.
  let text = body.length > CHAT_BODY_MAX_BYTES ? body.slice(0, CHAT_BODY_MAX_BYTES) : body;

  text = text.replace(FENCE, (_m, inner: string) => inner);
  // Escapes are shielded BEFORE any marker strip and restored after: `\*` is a
  // literal star, and must not be read as emphasis and half-eaten.
  text = text.replace(ESCAPE, (_m, ch: string) =>
    String.fromCharCode(SHIELD_BASE + ch.charCodeAt(0)),
  );
  text = text.replace(MENTION, (_m, id: string) => `@${members.get(id)?.name ?? "unknown"}`);
  // Images first: the link pattern would otherwise eat the `](…)` and strand
  // the leading `!`.
  text = text.replace(IMAGE, (_m, alt: string) => alt);
  text = text.replace(LINK, (_m, label: string) => label);
  text = text.replace(THEMATIC_BREAK, " ");
  text = text.replace(TABLE_RULE, " ");
  text = text.replace(LINE_PREFIX, "");
  text = text.replace(EMPHASIS, "");
  text = text.replace(/[ \t]*\|[ \t]*/g, " ");
  text = text.replace(SHIELDED, (m) => String.fromCharCode(m.charCodeAt(0) - SHIELD_BASE));

  return text.replace(/\s+/g, " ").trim();
}
