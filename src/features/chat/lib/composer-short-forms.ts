// The session composer's serializer: a mention chip writes its short form
// (`toShortForm` — `@file:src/x.ts`, `@session:"Fix it"`, `#rule:style`), so
// the prompt the agent receives is byte-for-byte what the CodeMirror composer
// sent, and `compose_prompt` downstream is untouched.
//
// The reverse trip turns a short-form token back into a chip when
// `mention-registry.ts` can say which mention it stands for — and only when
// that mention writes back exactly the same token, so text → doc → text is
// the identity whatever the registry knows (`composer-short-forms.test.ts`).

import type { JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

import type { ComposerSerializer } from "@/components/composer/composer-doc";
import { toShortForm, type MentionData } from "./mentions";
import { knownMention, rebuildMention } from "./mention-registry";

/** The chip node's schema name. */
export const SESSION_MENTION = "sessionMention";

/** Every prefix `toShortForm` writes. Not anchored inside words, so an
 *  email's `a@file:x` stays text. A value with whitespace is quoted and runs
 *  to the closing quote; a bare value runs to the next whitespace. The
 *  transcript's reader (`markdown-render.ts`) matches the same tokens. */
const SHORT_FORM_RE =
  /(?<![\w/])((?:@(?:file|folder|symbol|note|repo|workspace|branch|msg|session|member|conversation|recorded-session|comment|paste|cite|review))|(?:#(?:command|agent|rule))):(?:"([^"\n]+)"|(?!")(\S+))/g;

/** A short-form token found in text. */
export interface ShortFormToken {
  /** `@file`, `#rule`, … */
  prefix: string;
  /** The value, unquoted. */
  value: string;
  /** The token exactly as written, quotes included. */
  raw: string;
}

/** Who can say what a token stands for: a mention minted this run, by its
 *  exact token; failing that, one rebuilt from the token alone. */
export interface MentionResolver {
  known(token: ShortFormToken): MentionData | null;
  rebuilt(token: ShortFormToken): MentionData | null;
}

/** One line → text runs and mention chips. A bare value may end in a
 *  sentence's punctuation (`see @file:a.ts.`), so it is tried with and without
 *  it: a minted mention matches its exact token either way (`@folder:v(1)`
 *  keeps its parenthesis), and a rebuilt one takes the peeled value first, so
 *  the full stop is not swallowed into a path. */
export function tokenizeShortForms(line: string, resolve: MentionResolver): JSONContent[] {
  const out: JSONContent[] = [];
  let cursor = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.type === "text") last.text = `${last.text}${text}`;
    else out.push({ type: "text", text });
  };
  SHORT_FORM_RE.lastIndex = 0;
  for (let m = SHORT_FORM_RE.exec(line); m; m = SHORT_FORM_RE.exec(line)) {
    const [match, prefix, quoted, bare] = m;
    const candidates: ShortFormToken[] = [];
    if (quoted !== undefined) {
      candidates.push({ prefix, value: quoted, raw: match });
    } else if (bare) {
      candidates.push({ prefix, value: bare, raw: match });
      const peeled = bare.replace(/[.,;:!?)\]]+$/, "");
      if (peeled && peeled !== bare) {
        candidates.push({ prefix, value: peeled, raw: `${prefix}:${peeled}` });
      }
    }
    for (const [token, mention] of attempts(candidates, resolve)) {
      // Only a mention that writes back the same bytes may replace them.
      if (!mention || toShortForm(mention) !== token.raw) continue;
      pushText(line.slice(cursor, m.index));
      out.push({ type: SESSION_MENTION, attrs: { data: mention } });
      cursor = m.index + token.raw.length;
      break;
    }
  }
  pushText(line.slice(cursor));
  return out;
}

/** Each candidate against the minted mentions, then each, peeled first,
 *  rebuilt — one at a time, so a match stops the search. */
function* attempts(
  candidates: ShortFormToken[],
  resolve: MentionResolver,
): Generator<readonly [ShortFormToken, MentionData | null]> {
  for (const token of candidates) yield [token, resolve.known(token)];
  for (let i = candidates.length - 1; i >= 0; i--) {
    yield [candidates[i], resolve.rebuilt(candidates[i])];
  }
}

/** The session composer's serializer. `getProjectPath` is read per token, so
 *  one serializer serves a project switch. */
export function sessionSerializer(getProjectPath: () => string | null): ComposerSerializer {
  const resolve: MentionResolver = {
    known: (token) => knownMention(token.raw, getProjectPath()),
    rebuilt: (token) => rebuildMention(token, getProjectPath()),
  };
  return {
    tokenize: (lines) => lines.map((line) => (line ? tokenizeShortForms(line, resolve) : [])),
    chipText: (node: PMNode) => toShortForm(node.attrs.data as MentionData),
  };
}
