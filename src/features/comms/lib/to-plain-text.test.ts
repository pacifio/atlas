import { describe, expect, it } from "vitest";
import { toPlainText } from "./to-plain-text";
import type { OrgMemberProfile } from "../types";

const members = new Map<string, OrgMemberProfile>([
  ["u_ada", { id: "u_ada", name: "Ada Lovelace", email: "ada@x.test", role: "member" }],
]);

const flat = (body: string) => toPlainText(body, members);

describe("toPlainText", () => {
  it("resolves a mention to a name, and an unknown id honestly", () => {
    expect(flat("hi <@u_ada>")).toBe("hi @Ada Lovelace");
    expect(flat("hi <@u_ghost>")).toBe("hi @unknown");
  });

  it("leaves broadcasts as the words they already are", () => {
    expect(flat("@channel ship it")).toBe("@channel ship it");
  });

  it("strips every marker the composer toolbar can insert", () => {
    expect(flat("**bold**")).toBe("bold");
    expect(flat("*italic*")).toBe("italic");
    expect(flat("~~struck~~")).toBe("struck");
    expect(flat("`code`")).toBe("code");
    expect(flat("[label](https://x.test)")).toBe("label");
    expect(flat("- one\n- two")).toBe("one two");
    expect(flat("1. one\n2. two")).toBe("one two");
    expect(flat("> quoted")).toBe("quoted");
  });

  it("flattens the constructs the renderer newly supports", () => {
    expect(flat("# Heading")).toBe("Heading");
    expect(flat("__bold__ and ___both___")).toBe("bold and both");
    expect(flat("- [ ] todo\n- [x] done")).toBe("todo done");
    expect(flat("a\n\n---\n\nb")).toBe("a b");
    expect(flat("![a diagram](https://x.test/i.png)")).toBe("a diagram");
    expect(flat("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe("a b 1 2");
  });

  it("keeps the contents of a fenced block, without the fence", () => {
    expect(flat("look:\n```ts\nconst a = 1;\n```")).toBe("look: const a = 1;");
  });

  it("unescapes backslash escapes", () => {
    expect(flat("literal \\*stars\\*")).toBe("literal *stars*");
  });

  it("always returns a single line", () => {
    expect(flat("one\ntwo\n\n\nthree")).toBe("one two three");
    expect(flat("  padded  ")).toBe("padded");
  });

  it("survives an empty or marker-only body", () => {
    expect(flat("")).toBe("");
    expect(flat("***")).toBe("");
  });

  it("handles a realistic mixed message", () => {
    expect(flat("**ship it** <@u_ada>\n> after review\n- [x] tests")).toBe(
      "ship it @Ada Lovelace after review tests",
    );
  });
});
