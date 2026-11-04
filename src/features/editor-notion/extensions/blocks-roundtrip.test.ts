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

  // KNOWN BUG, pre-existing: the toggle's `parseHTML` reads `<details>` whole,
  // so the `<summary>` text is parsed as body content too and every load + save
  // adds one more copy of the title as a paragraph. Fixing it means changing
  // `parseHTML`, which this restyle must not touch. This pins the bug, so the
  // fix turns it red: then assert `toBe(once)` instead.
  it("KNOWN BUG: a toggle's title is added to its body on every save", () => {
    const once = rt(guide!.content);
    const twice = rt(once);
    expect(twice).not.toBe(once);
    expect(twice.split("Sign-in redirects in a loop")).toHaveLength(
      once.split("Sign-in redirects in a loop").length + 1,
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
