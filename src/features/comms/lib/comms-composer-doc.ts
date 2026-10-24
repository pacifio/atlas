// Team chat's side of the composer's document model: which text is a mention
// pill and what text a pill stands for.
//
// The wire text is the contract. A message body holds a mention as the
// `<@user_id>` token (and a broadcast as the bare `@channel` / `@here`), and a
// pill writes exactly that token back, so the draft, the byte counter and the
// send see the same text the CodeMirror composer handed them.
//
// What becomes a pill follows the message renderer, so the pill you type is
// the pill you send:
//   - only the server's patterns (`MENTION_SOURCE` / `BROADCAST_SOURCE`);
//   - nothing inside a code fence or a `` `code span` ``, which the renderer
//     prints literally;
//   - and only a member the roster can name. An unresolved id stays the raw
//     token: a pill reading "@unknown" would hide who is about to be notified.

import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

import { FenceTracker, type ComposerSerializer } from "@/components/composer/composer-doc";
import { BROADCAST_SOURCE, MENTION_SOURCE } from "../types";
import type { OrgMemberProfile } from "../types";

/** The pill node's schema name. */
export const COMMS_MENTION = "commsMention";

/** A pill's record: a member by id, or a broadcast. */
export type CommsMentionData = { userId: string } | { broadcast: "channel" | "here" };

export interface MentionDirectory {
  members: Map<string, OrgMemberProfile>;
  /** The current user — a mention of them reads as addressed to you. */
  me: string;
}

/** The text a pill stands for. */
export function commsMentionText(data: CommsMentionData): string {
  return "userId" in data ? `<@${data.userId}>` : `@${data.broadcast}`;
}

const SCANNER = new RegExp(`${MENTION_SOURCE}|${BROADCAST_SOURCE}`, "g");
const MAY_BE_FENCE = /^ {0,3}(?:```|~~~)/;

/** Whether a line could open or close a code fence. Cheap, and true of every
 *  line that does: what decides whether a change can move fences. Whether it
 *  does is `FenceTracker`'s call, with the lines above it. */
export function mayBeFenceLine(line: string): boolean {
  return MAY_BE_FENCE.test(line);
}

/** The `[from, to)` spans of one line that are inline code. */
function inlineCode(line: string): [number, number][] {
  const spans: [number, number][] = [];
  let tick = line.indexOf("`");
  while (tick !== -1) {
    const close = line.indexOf("`", tick + 1);
    if (close === -1) break;
    spans.push([tick, close + 1]);
    tick = line.indexOf("`", close + 1);
  }
  return spans;
}

/** A pill found in one line of text. */
export interface PillMatch {
  index: number;
  length: number;
  data: CommsMentionData;
}

/**
 * The pills one line holds. `fenced` is whether the line is fence markup or
 * sits inside a fence (`FenceTracker`, fed the lines above it). A scanner rather than a
 * markdown parse: getting it slightly wrong costs a pill that should have been
 * plain text, never a wrong message.
 */
export function pillsInLine(
  line: string,
  fenced: boolean,
  members: ReadonlyMap<string, OrgMemberProfile>,
): PillMatch[] {
  if (fenced || !line.includes("@")) return [];
  const code = inlineCode(line);
  const out: PillMatch[] = [];
  SCANNER.lastIndex = 0;
  for (let m = SCANNER.exec(line); m; m = SCANNER.exec(line)) {
    const at = m.index;
    if (code.some(([from, to]) => at >= from && at < to)) continue;
    const [raw, userId, broadcast] = m;
    if (userId !== undefined) {
      if (!members.has(userId)) continue;
      out.push({ index: at, length: raw.length, data: { userId } });
    } else {
      out.push({
        index: at,
        length: raw.length,
        data: { broadcast: broadcast as "channel" | "here" },
      });
    }
  }
  return out;
}

/** One line → text runs and pills. */
function tokenizeLine(
  line: string,
  fenced: boolean,
  members: ReadonlyMap<string, OrgMemberProfile>,
): JSONContent[] {
  const out: JSONContent[] = [];
  let cursor = 0;
  for (const pill of pillsInLine(line, fenced, members)) {
    if (pill.index > cursor) out.push({ type: "text", text: line.slice(cursor, pill.index) });
    out.push({ type: COMMS_MENTION, attrs: { data: pill.data } });
    cursor = pill.index + pill.length;
  }
  if (cursor < line.length) out.push({ type: "text", text: line.slice(cursor) });
  return out;
}

/** Team chat's serializer. `getMembers` is read per call, so pills follow the
 *  roster as it loads. */
export function commsSerializer(
  getMembers: () => ReadonlyMap<string, OrgMemberProfile>,
): ComposerSerializer {
  return {
    tokenize(lines) {
      const members = getMembers();
      const fences = new FenceTracker();
      return lines.map((line) => tokenizeLine(line, fences.line(line), members));
    },
    chipText: (node: PMNode) => commsMentionText(node.attrs.data as CommsMentionData),
  };
}
