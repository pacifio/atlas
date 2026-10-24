// @vitest-environment happy-dom
//
// The composer core's document model (`composer-doc.ts`) under a toy
// serializer: `{{name}}` is a chip. What a feature's round-trip test relies on
// is held here once — text → doc → text is the identity for any text, string
// offsets and document positions map onto each other across chips and line
// breaks, and the per-keystroke checks (`isDocBlank`, `isLargePaste`) say what
// the slower whole-document reading would.

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextSelection } from "@tiptap/pm/state";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { createChipNode, parseChipRecord } from "./composer-chip";
import {
  LARGE_PASTE_CHARS,
  LARGE_PASTE_LINES,
  docChips,
  docToText,
  isDocBlank,
  isDocEmpty,
  isLargePaste,
  posToTextOffset,
  textOffsetToPos,
  textToDoc,
  type ComposerSerializer,
} from "./composer-doc";
import { continueMarkup } from "./composer-keymap";

const Tag = createChipNode<string>({
  name: "tag",
  toText: (name) => `{{${name}}}`,
  view: () => null,
});

const serializer: ComposerSerializer = {
  tokenize: (lines) => lines.map(tokenizeLine),
  chipText: (node) => `{{${node.attrs.data as string}}}`,
};

function tokenizeLine(line: string): JSONContent[] {
  const out: JSONContent[] = [];
  let cursor = 0;
  for (const m of line.matchAll(/\{\{(\w+)\}\}/g)) {
    if (m.index > cursor) out.push({ type: "text", text: line.slice(cursor, m.index) });
    out.push({ type: "tag", attrs: { data: m[1] } });
    cursor = m.index + m[0].length;
  }
  if (cursor < line.length) out.push({ type: "text", text: line.slice(cursor) });
  return out;
}

const editors: Editor[] = [];
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy();
});

/** A headless editor with the composer's schema: paragraphs, text, chips. */
function editorWith(text: string): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bold: false,
        bulletList: false,
        code: false,
        codeBlock: false,
        dropcursor: false,
        gapcursor: false,
        hardBreak: false,
        heading: false,
        horizontalRule: false,
        italic: false,
        link: false,
        listItem: false,
        listKeymap: false,
        orderedList: false,
        strike: false,
        trailingNode: false,
        underline: false,
      }),
      Tag,
    ],
    content: textToDoc(text, serializer),
  });
  editors.push(editor);
  return editor;
}

const SAMPLES = [
  "",
  "one line",
  "  leading and trailing  ",
  "two\nlines",
  "blank\n\n\nlines between",
  "\nstarts and ends with a newline\n",
  "a {{chip}} mid-line",
  "{{first}}{{glued}} chips\n{{alone}}",
  "```ts\nconst x = {{inside}};\n```",
  "tabs\tand unicode — ✓ 日本語",
];

describe("text ↔ doc", () => {
  it.each(SAMPLES)("round-trips %j", (text) => {
    expect(docToText(editorWith(text).state.doc, serializer)).toBe(text);
  });

  it("makes each line a paragraph and each token a chip", () => {
    const doc = editorWith("a {{x}}\n\n{{y}}").state.doc;
    expect(doc.childCount).toBe(3);
    expect(docChips(doc, "tag").map((n) => n.attrs.data)).toEqual(["x", "y"]);
  });
});

describe("offsets ↔ positions", () => {
  const text = "ab {{chip}} cd\n\nef";

  it("maps every text offset outside a chip onto the position holding it", () => {
    const doc = editorWith(text).state.doc;
    const chip = text.indexOf("{{");
    const chipEnd = chip + "{{chip}}".length;
    for (let offset = 0; offset <= text.length; offset++) {
      if (offset > chip && offset < chipEnd) continue;
      const pos = textOffsetToPos(doc, offset, serializer);
      expect(posToTextOffset(doc, pos, serializer)).toBe(offset);
    }
  });

  it("puts an offset inside a chip after it", () => {
    const doc = editorWith(text).state.doc;
    const inside = text.indexOf("{{") + 3;
    const after = text.indexOf("{{") + "{{chip}}".length;
    expect(textOffsetToPos(doc, inside, serializer)).toBe(textOffsetToPos(doc, after, serializer));
  });

  it("clamps past the end", () => {
    const doc = editorWith(text).state.doc;
    expect(textOffsetToPos(doc, 999, serializer)).toBe(doc.content.size - 1);
  });
});

describe("per-keystroke checks", () => {
  it("isDocBlank agrees with trimming the text", () => {
    for (const text of [...SAMPLES, "   ", "\n \n\t", "{{x}}"]) {
      const doc = editorWith(text).state.doc;
      expect(isDocBlank(doc)).toBe(docToText(doc, serializer).trim() === "");
    }
  });

  it("isDocEmpty is the one empty line only", () => {
    expect(isDocEmpty(editorWith("").state.doc)).toBe(true);
    expect(isDocEmpty(editorWith(" ").state.doc)).toBe(false);
    expect(isDocEmpty(editorWith("\n").state.doc)).toBe(false);
  });

  it("isLargePaste trips on either limit and not before", () => {
    expect(isLargePaste("x".repeat(LARGE_PASTE_CHARS))).toBe(false);
    expect(isLargePaste("x".repeat(LARGE_PASTE_CHARS + 1))).toBe(true);
    expect(isLargePaste("x\n".repeat(LARGE_PASTE_LINES - 1) + "x")).toBe(false);
    expect(isLargePaste("x\n".repeat(LARGE_PASTE_LINES) + "x")).toBe(true);
  });
});

describe("continueMarkup", () => {
  /** Enter at the end of the last line, as the keymap would press it. */
  function enterAtEnd(text: string): string {
    const editor = editorWith(text);
    const end = editor.state.doc.content.size - 1;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)));
    if (!continueMarkup(editor.state, (tr) => editor.view.dispatch(tr))) return "(declined)";
    return docToText(editor.state.doc, serializer);
  }

  it("carries a bullet, a number, a task box and a quote onto the next line", () => {
    expect(enterAtEnd("- one")).toBe("- one\n- ");
    expect(enterAtEnd("  * nested")).toBe("  * nested\n  * ");
    expect(enterAtEnd("9. nine")).toBe("9. nine\n10. ");
    expect(enterAtEnd("- [x] done")).toBe("- [x] done\n- [ ] ");
    expect(enterAtEnd("> quoted")).toBe("> quoted\n> ");
  });

  it("ends an empty item, outdenting a nested one first", () => {
    expect(enterAtEnd("- one\n- ")).toBe("- one\n");
    expect(enterAtEnd("- one\n  - ")).toBe("- one\n- ");
  });

  it("declines a line that is not a list or a quote", () => {
    expect(enterAtEnd("plain")).toBe("(declined)");
  });
});

describe("chip records from HTML", () => {
  it("parseChipRecord takes a plain JSON object and nothing else", () => {
    expect(parseChipRecord('{"a":1}')).toEqual({ a: 1 });
    for (const raw of [null, "", "null", "[1]", "3", '"s"', "true", "{nope"]) {
      expect(parseChipRecord(raw)).toBeNull();
    }
  });

  it("a span whose payload is not an object pastes as its text", () => {
    const editor = editorWith("");
    editor.view.pasteHTML(`<span data-composer-chip="tag" data-chip="[1]">{{kept}}</span>`);
    expect(docChips(editor.state.doc, "tag")).toEqual([]);
    expect(editor.state.doc.textContent).toBe("{{kept}}");
  });
});
