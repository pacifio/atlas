// The two inline constructs a chat message has that markdown does not.
//
// 1. **Mentions.** Bodies store `<@user_id>`; the directory resolves it to a
//    name at render time. This runs as a remark (mdast) plugin rather than a
//    string pre-pass or a rehype/HTML step, and that choice is what makes the
//    whole thing safe:
//
//    - `<@id>` survives micromark as a plain TEXT node — `@` starts neither an
//      autolink scheme nor an HTML tag name, and `_` inside an id is intraword
//      so no emphasis fires. There is nothing for a sanitizer to strip because
//      no HTML is ever produced.
//    - A token inside `` `code` `` or a fence is unreachable STRUCTURALLY:
//      `inlineCode` and `code` nodes carry a `value`, not `children`, so a walk
//      that only rewrites `text` children can never see them. The old renderer
//      got this right too, but by regex-alternation ordering — a property that
//      holds only as long as nobody reorders the alternation.
//
//    The node carries the id, not the name: `message-body-impl` resolves it
//    through React context on every render, so a rename repaints and history
//    stays untouched.
//
// 2. **Hard breaks.** A single newline is a visible line break in a chat
//    message — Slack semantics, and what every message already in the database
//    assumes. CommonMark collapses it to a space. Emitting `break` nodes is
//    what preserves that; without it every multi-line message silently
//    reflows. It is done in this same walk because it is the same text-node
//    split, and the alternative (`white-space: pre-wrap` on the paragraph)
//    would also resurrect markdown's structural indentation inside list items.
//
// Both patterns come from `../types`, which mirrors the server's. A second
// regex here would highlight people the server never notified.

import type { Root, RootContent, PhrasingContent } from "mdast";
import { BROADCAST_SOURCE, MENTION_SOURCE } from "../types";

/** Tag name the mention node becomes. See the note on `data-*` below. */
const MENTION_TAG = "span";

/**
 * One scan for all three splits. Group 1 is a user id, group 2 is the
 * broadcast word, group 3 is a newline — the order matches the alternation, so
 * whichever is defined says what matched.
 */
function scanner(): RegExp {
  return new RegExp(`${MENTION_SOURCE}|${BROADCAST_SOURCE}|(\n)`, "g");
}

/**
 * A mention as mdast.
 *
 * `data.hName`/`hProperties`/`hChildren` is the documented route from an
 * unknown mdast node to a hast element: `mdast-util-to-hast` takes the
 * "properties present" branch and `applyData` rewrites the tag and children.
 * react-markdown then renders it through the `components` map.
 *
 * The payload rides in `data-*` attributes deliberately. A `data-*` name is
 * the one class of property that reaches React verbatim — `property-information`
 * gives it no `space`, so the attribute name is not camel-mangled the way a
 * bare `mentionId` would be (it would arrive as `mentionid`). Using a real
 * `span` rather than a custom tag name also keeps react-markdown's `Components`
 * type happy without a cast, and degrades honestly: if the override ever fails
 * to match, the reader sees the literal token in a plain span rather than an
 * unknown element the browser silently swallows.
 */
function mentionNode(attr: "data-mention" | "data-broadcast", value: string, raw: string) {
  return {
    type: "commsMention",
    data: {
      hName: MENTION_TAG,
      hProperties: { [attr]: value },
      hChildren: [{ type: "text", value: raw }],
    },
  } as unknown as PhrasingContent;
}

/**
 * Split one text value into mentions, breaks and the literal runs between.
 *
 * Returns `null` when nothing matched, so the overwhelmingly common case — a
 * text node with no mention and no newline — keeps its identity and the parent
 * is left completely untouched.
 */
function splitText(value: string): PhrasingContent[] | null {
  const re = scanner();
  const out: PhrasingContent[] = [];
  let last = 0;

  for (let m = re.exec(value); m; m = re.exec(value)) {
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    last = m.index + m[0].length;

    const [raw, mention, broadcast, newline] = m;
    if (mention !== undefined) {
      out.push(mentionNode("data-mention", mention, raw));
    } else if (broadcast !== undefined) {
      out.push(mentionNode("data-broadcast", broadcast, raw));
    } else if (newline !== undefined) {
      out.push({ type: "break" });
    }
  }

  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

type Parent = Extract<RootContent | Root, { children: unknown[] }>;

/**
 * Rewrite every `text` descendant, recursing through everything that has
 * children.
 *
 * The `children` check is the load-bearing line: a node without it is a leaf
 * carrying a `value` (`inlineCode`, `code`, `html`, `image`), which is exactly
 * the set a mention must never be substituted into.
 */
function walk(node: Parent): void {
  let rewrote = false;
  const next: RootContent[] = [];

  for (const child of node.children as RootContent[]) {
    if (child.type === "text") {
      const parts = splitText(child.value);
      if (parts) {
        rewrote = true;
        next.push(...(parts as RootContent[]));
        continue;
      }
    } else if ("children" in child && Array.isArray(child.children)) {
      walk(child as Parent);
    }
    next.push(child);
  }

  if (rewrote) node.children = next as Parent["children"];
}

/** Resolve `<@id>`, `@channel`/`@here` and soft line breaks. */
export function remarkCommsInline() {
  return (tree: Root): void => {
    walk(tree);
  };
}
