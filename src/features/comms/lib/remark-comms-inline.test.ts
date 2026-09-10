import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Root } from "mdast";

import { remarkCommsInline } from "./remark-comms-inline";

function parse(src: string): Root {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(src) as Root;
  remarkCommsInline()(tree);
  return tree;
}

/** Every node of a type, anywhere in the tree. */
function collect(node: unknown, type: string, out: Record<string, unknown>[] = []) {
  const n = node as { type?: string; children?: unknown[] };
  if (n?.type === type) out.push(n as Record<string, unknown>);
  for (const child of n?.children ?? []) collect(child, type, out);
  return out;
}

function mentions(src: string) {
  return collect(parse(src), "commsMention").map((n) => {
    const data = n.data as { hProperties: Record<string, string>; hChildren: { value: string }[] };
    return { props: data.hProperties, text: data.hChildren[0].value };
  });
}

describe("remarkCommsInline", () => {
  it("turns a user mention into a node carrying the id, not the name", () => {
    expect(mentions("hi <@u_1.a:b-c> there")).toEqual([
      { props: { "data-mention": "u_1.a:b-c" }, text: "<@u_1.a:b-c>" },
    ]);
  });

  // The regression the whole design rests on. A mention inside code is
  // unreachable because `inlineCode`/`code` carry a value, not children — if
  // this ever fails, the walk has started rewriting leaf values.
  it("NEVER substitutes inside inline code or a fence", () => {
    expect(mentions("look at `<@u_1>` here")).toEqual([]);
    expect(mentions("```\n<@u_1>\n```")).toEqual([]);
    expect(mentions("```ts\nconst a = '<@u_1>'; // @channel\n```")).toEqual([]);
  });

  it("keeps the code node's text exactly as written", () => {
    const code = collect(parse("`<@u_1>`"), "inlineCode")[0];
    expect(code.value).toBe("<@u_1>");
  });

  it("matches @channel and @here but not addresses or intraword uses", () => {
    expect(mentions("@channel ship it")).toEqual([
      { props: { "data-broadcast": "channel" }, text: "@channel" },
    ]);
    expect(mentions("@here")).toEqual([{ props: { "data-broadcast": "here" }, text: "@here" }]);
    expect(mentions("mail a@here.com or foo@channel")).toEqual([]);
  });

  it("resolves mentions inside every kind of parent", () => {
    const cases = [
      "# <@u_1>",
      "- <@u_1>",
      "> <@u_1>",
      "**<@u_1>**",
      "[<@u_1>](https://x.test)",
      "| a |\n| --- |\n| <@u_1> |",
      "1. outer\n   - <@u_1>",
    ];
    for (const src of cases) {
      expect(mentions(src), src).toHaveLength(1);
    }
  });

  it("honours the id length bounds from the contract pattern", () => {
    expect(mentions(`<@${"a".repeat(128)}>`)).toHaveLength(1);
    expect(mentions(`<@${"a".repeat(129)}>`)).toHaveLength(0);
    expect(mentions("<@>")).toHaveLength(0);
    expect(mentions("<@has space>")).toHaveLength(0);
  });

  // Without this every multi-line message silently reflows into one paragraph.
  it("turns a soft newline into a break node", () => {
    expect(collect(parse("one\ntwo\nthree"), "break")).toHaveLength(2);
  });

  it("does not break up newlines inside code", () => {
    expect(collect(parse("```\none\ntwo\n```"), "break")).toHaveLength(0);
  });

  it("leaves an ordinary text node untouched, by identity", () => {
    const tree = unified().use(remarkParse).use(remarkGfm).parse("just words") as Root;
    const before = (tree.children[0] as { children: unknown[] }).children[0];
    remarkCommsInline()(tree);
    expect((tree.children[0] as { children: unknown[] }).children[0]).toBe(before);
  });

  it("keeps the literal text between two mentions", () => {
    const para = parse("<@u_1> and <@u_2>").children[0] as { children: { type: string }[] };
    expect(para.children.map((c) => c.type)).toEqual(["commsMention", "text", "commsMention"]);
  });
});
