// @vitest-environment happy-dom
//
// The custom blocks' markdown is the file on disk: restyling a node view must
// not change a byte of it. This loads real notes through the real extension
// stack and checks the serialized form is stable and keeps each block's wire
// shape.
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// The editor stack (and the fixture module) touch Tauri events on load.
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import { listKnowledgeEntries } from "@/dev/mock-backend/fixtures/knowledge";
import { buildExtensions } from "../lib/extensions";

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

/** Load markdown into the real editor stack and serialize it back. */
function rt(markdown: string): string {
  editor?.destroy();
  editor = new Editor({ extensions: buildExtensions(), content: markdown });
  const storage = editor.storage as unknown as Record<string, { getMarkdown: () => string }>;
  return storage.markdown.getMarkdown();
}

const FENCE = "```";

describe("custom blocks round-trip", () => {
  const guide = listKnowledgeEntries().find((e) => e.id === "guides/debugging-guide");

  it("the debugging guide keeps every block's wire shape", () => {
    expect(guide).toBeDefined();
    const once = rt(guide!.content);
    expect(once).toContain('<aside class="atlas-callout" data-emoji="🚨">');
    expect(once.match(/<details/g)).toHaveLength(2);
    expect(once.split(`${FENCE}bash`)).toHaveLength(3);
  });

  it("a note with toggles saves to the same markdown after a load + save", () => {
    const once = rt(guide!.content);
    expect(rt(once)).toBe(once);
    expect(once.split("Sign-in redirects in a loop")).toHaveLength(
      guide!.content.split("Sign-in redirects in a loop").length,
    );
  });

  /**
   * Saved once, then reloaded and saved again five times: byte-identical. The
   * first save writes the serializer's canonical form (a blank line before
   * `</details>`, "Untitled" for an empty title); no save after it may change
   * a byte.
   */
  function expectStable(markdown: string): string {
    const once = rt(markdown);
    let out = once;
    for (let i = 0; i < 5; i++) out = rt(out);
    expect(out).toBe(once);
    return once;
  }

  it("a note with toggles is unchanged after several load + save rounds", () => {
    expectStable(guide!.content);
  });

  it("a toggle nested in a toggle round-trips unchanged", () => {
    const md = [
      "<details open>",
      "<summary>Outer</summary>",
      "",
      "outer body",
      "",
      "<details>",
      "<summary>Inner</summary>",
      "",
      "inner body",
      "",
      "</details>",
      "",
      "</details>",
    ].join("\n");
    const out = expectStable(md);
    expect(out.match(/<details/g)).toHaveLength(2);
    for (const text of ["Outer", "outer body", "Inner", "inner body"]) {
      expect(out.split(text)).toHaveLength(2);
    }
    expect(out.indexOf("<summary>Inner</summary>")).toBeGreaterThan(out.indexOf("outer body"));
  });

  it("a toggle with an empty title round-trips unchanged", () => {
    const out = expectStable("<details open>\n<summary></summary>\n\nbody\n\n</details>");
    expect(out).toContain("<summary>Untitled</summary>");
    expect(out.match(/body/g)).toHaveLength(1);
  });

  it("a toggle with an empty body round-trips unchanged", () => {
    const out = expectStable("<details open>\n<summary>Empty</summary>\n\n</details>");
    expect(out.match(/Empty/g)).toHaveLength(1);
  });

  it("a toggle in the editor's own HTML shape loads back without its title in the body", () => {
    const once = rt("<details open>\n<summary>Copied</summary>\n\nbody\n\n</details>");
    const html = editor!.getHTML();
    expect(html).toContain('class="atlas-toggle-body"');
    expect(rt(html)).toBe(once);
  });

  it("a toggle title with an ampersand or an entity in it round-trips unchanged", () => {
    for (const title of ["Q&A", "Use &amp; for &", "a &lt; b < c"]) {
      rt(`<details open>\n<summary>x</summary>\n\nbody\n\n</details>`);
      editor!.commands.command(({ tr }) => {
        tr.setNodeAttribute(0, "title", title);
        return true;
      });
      const storage = editor!.storage as unknown as Record<string, { getMarkdown: () => string }>;
      const saved = storage.markdown.getMarkdown();
      expectStable(saved);
      rt(saved);
      expect(editor!.state.doc.firstChild?.attrs.title).toBe(title);
    }
    // A plain ampersand is written as it reads.
    expect(rt("<details open>\n<summary>Q&A</summary>\n\nbody\n\n</details>")).toContain(
      "<summary>Q&A</summary>",
    );
  });

  it("a closed toggle stays closed", () => {
    const out = rt("<details>\n<summary>Closed</summary>\n\nbody\n\n</details>");
    expect(out).toContain("<details>\n<summary>Closed</summary>");
    expect(out).not.toContain("<details open>");
  });

  it("a code block with no language round-trips without one", () => {
    const out = rt(`${FENCE}\nplain text\n${FENCE}`);
    expect(out).toBe(`${FENCE}\nplain text\n${FENCE}`);
  });

  it("a knowledge mention survives", () => {
    expect(rt("See @knowledge:roadmap-q4 today.")).toContain("@knowledge:roadmap-q4");
  });
});
