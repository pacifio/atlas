import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown-render";

/** The labels of every mention chip in the rendered HTML, in order. */
function chipLabels(html: string): string[] {
  return [...html.matchAll(/atlas-mention-chip__label">([^<]*)</g)].map((m) => m[1]);
}

describe("mention chips in rendered markdown", () => {
  it("keeps a quoted name with spaces in one chip", () => {
    const html = parseMarkdown(
      '@file:"CleanShot 2026-09-15 at 10.04.08 PM@2x.png" can you see this issue?',
    );
    expect(chipLabels(html)).toEqual(["CleanShot 2026-09-15 at 10.04.08 PM@2x.png"]);
    expect(html).toContain("can you see this issue?");
  });

  // GFM reads `Shot@2x.png` as an email autolink literal; left in the source,
  // it split the token before the chip pass ever saw it.
  it("does not let an @ in the name become an email link", () => {
    const html = parseMarkdown("look at @file:Shot@2x.png please");
    expect(chipLabels(html)).toEqual(["Shot@2x.png"]);
    expect(html).not.toContain("mailto:");
  });

  it("shows a path mention by its base name", () => {
    expect(chipLabels(parseMarkdown("@file:src/lib/a.ts"))).toEqual(["a.ts"]);
  });

  // A linked comment's label has a colon, slashes and spaces in it; it must
  // stay one chip and never be shortened like a path.
  it("draws a linked comment as one comment chip, label whole", () => {
    const html = parseMarkdown('check @comment:"Grace: retry in src/net.ts never backs off" first');
    expect(chipLabels(html)).toEqual(["Grace: retry in src/net.ts never backs off"]);
    expect(html).toContain('data-mention-kind="comment"');
    expect(html).toContain("first");
  });

  // A sent message keeps the `@paste:<id>` / `@cite:<id>` tokens its chips
  // wrote; the id means nothing to a reader, so the chip says what it is.
  it("draws a paste and a cite by what they are, not their ids", () => {
    const html = parseMarkdown("why @cite:k3x9q2 given @paste:p7d1aa?");
    expect(chipLabels(html)).toEqual(["Cited passage", "Pasted text"]);
    expect(html).toContain('data-mention-kind="cited_text"');
    expect(html).toContain('data-mention-kind="pasted_text"');
    expect(html).not.toContain(">k3x9q2<");
    expect(html).toContain("?");
  });

  it("peels trailing punctuation off a bare value", () => {
    const html = parseMarkdown("see @file:a.ts, then run");
    expect(chipLabels(html)).toEqual(["a.ts"]);
    expect(html).toContain(", then run");
  });

  it("leaves tokens inside code literal", () => {
    const html = parseMarkdown('`@file:"My Shot.png"` and\n\n```\n@file:a.ts\n```');
    expect(chipLabels(html)).toEqual([]);
    expect(html).toMatch(/@file:(&#x22;|&quot;|")My Shot\.png/);
    expect(html).toContain("@file:a.ts");
  });

  it("does not chip a token glued to a word", () => {
    expect(chipLabels(parseMarkdown("mail a@file:x"))).toEqual([]);
  });

  it("does not chip an unclosed quote mid-stream", () => {
    expect(chipLabels(parseMarkdown('@file:"My Sh'))).toEqual([]);
  });
});
