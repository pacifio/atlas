// @vitest-environment happy-dom
//
// The editing the CodeMirror composer gave both composers for free, held on
// the shared core: no browser typing corrections, the markdown list keys
// (a marker Backspace removes, numbered lists that renumber, no list
// continuation inside a code fence), the line keys (move, copy, indent,
// delete), and an arrow key that steps over a chip instead of selecting it.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

import { createChipNode } from "./composer-chip";
import { textOffsetToPos, type ComposerSerializer } from "./composer-doc";
import { ComposerEditor, type ComposerEditorHandle } from "./composer-editor";

const Tag = createChipNode<string>({
  name: "tag",
  toText: (name) => `{{${name}}}`,
  view: () => null,
});
const EXTENSIONS = [Tag];

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

const serializer: ComposerSerializer = {
  tokenize: (lines) => lines.map(tokenizeLine),
  chipText: (node) => `{{${node.attrs.data as string}}}`,
};

afterEach(cleanup);

/** A composer holding `text`, the caret at `|` (which is removed). */
function composer(marked: string) {
  const caret = marked.indexOf("|");
  const text = marked.replace("|", "");
  const ref = createRef<ComposerEditorHandle>();
  const { container } = render(
    <ComposerEditor
      ref={ref}
      extensions={EXTENSIONS}
      serializer={serializer}
      initialValue={text}
      enterToSend={false}
    />,
  );
  const dom = container.querySelector(".ProseMirror") as HTMLElement;
  const editor = ref.current!.editor()!;
  if (caret >= 0) {
    const pos = textOffsetToPos(editor.state.doc, caret, serializer);
    act(() => {
      editor.view.dispatch(
        editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)),
      );
    });
  }
  return { editor, dom, value: () => ref.current!.getValue() };
}

const MAC = /Mac|iP(hone|[oa]d)/.test(navigator.platform);
const KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Enter: 13,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  "[": 219,
  "]": 221,
  k: 75,
  K: 75,
};

/** Press `Mod-Shift-Alt-key`-style chords on the editor, as a real keydown. */
function press(dom: HTMLElement, chord: string) {
  const parts = chord.split("-");
  const key = parts.pop()!;
  const mods = new Set(parts);
  const shift = mods.has("Shift");
  const event = new KeyboardEvent("keydown", {
    key: shift && key.length === 1 ? key.toUpperCase() : key,
    bubbles: true,
    cancelable: true,
    shiftKey: shift,
    altKey: mods.has("Alt"),
    metaKey: mods.has("Mod") && MAC,
    ctrlKey: mods.has("Mod") && !MAC,
  });
  Object.defineProperty(event, "keyCode", { value: KEY_CODES[key] ?? 0 });
  act(() => {
    dom.dispatchEvent(event);
  });
}

/** The caret as a text offset into the value. */
function caretLine(editor: Editor): string {
  return editor.state.selection.$from.parent.textContent;
}

describe("typing corrections", () => {
  it("are off, as they were in CodeMirror", () => {
    const { dom } = composer("x");
    expect(dom.getAttribute("spellcheck")).toBe("false");
    expect(dom.getAttribute("autocorrect")).toBe("off");
    expect(dom.getAttribute("autocapitalize")).toBe("off");
    expect(dom.getAttribute("writingsuggestions")).toBe("false");
  });
});

describe("markdown lists", () => {
  it("Backspace right after a marker removes the marker", () => {
    const { dom, value } = composer("- |item");
    press(dom, "Backspace");
    expect(value()).toBe("item");
  });

  it("keeps a nested item's indent when its marker goes", () => {
    const { dom, value } = composer("- a\n  - |b");
    press(dom, "Backspace");
    expect(value()).toBe("- a\n  b");
  });

  it("Enter in a numbered list renumbers the items after it", () => {
    const { dom, value } = composer("1. a|\n2. b\n3. c");
    press(dom, "Enter");
    expect(value()).toBe("1. a\n2. \n3. b\n4. c");
  });

  it("removing an item's marker renumbers the items after it", () => {
    const { dom, value } = composer("1. a\n2. |b\n3. c\n4. d");
    press(dom, "Backspace");
    expect(value()).toBe("1. a\nb\n2. c\n3. d");
  });

  it("Enter inside an open fence is a plain newline", () => {
    const { dom, value } = composer("```\n- inside|");
    press(dom, "Enter");
    expect(value()).toBe("```\n- inside\n");
  });

  it("Enter after a closed fence continues a list again", () => {
    const { dom, value } = composer("```\ncode\n```\n- item|");
    press(dom, "Enter");
    expect(value()).toBe("```\ncode\n```\n- item\n- ");
  });
});

describe("line keys", () => {
  it("⌥↑ and ⌥↓ move the line, caret with it", () => {
    const { editor, dom, value } = composer("a\nb|\nc");
    press(dom, "Alt-ArrowUp");
    expect(value()).toBe("b\na\nc");
    expect(caretLine(editor)).toBe("b");
    press(dom, "Alt-ArrowDown");
    press(dom, "Alt-ArrowDown");
    expect(value()).toBe("a\nc\nb");
    expect(caretLine(editor)).toBe("b");
  });

  it("⇧⌥↓ and ⇧⌥↑ copy the line, chips and all", () => {
    const { dom, value } = composer("a {{t}}|\nz");
    press(dom, "Shift-Alt-ArrowDown");
    expect(value()).toBe("a {{t}}\na {{t}}\nz");
    press(dom, "Shift-Alt-ArrowUp");
    expect(value()).toBe("a {{t}}\na {{t}}\na {{t}}\nz");
  });

  it("⌘] and ⌘[ indent and outdent any line", () => {
    const { dom, value } = composer("plain|");
    press(dom, "Mod-]");
    expect(value()).toBe("  plain");
    press(dom, "Mod-[");
    expect(value()).toBe("plain");
  });

  it("⇧⌘K deletes the line", () => {
    const { editor, dom, value } = composer("a\nb|\nc");
    press(dom, "Shift-Mod-k");
    expect(value()).toBe("a\nc");
    expect(caretLine(editor)).toBe("c");
  });
});

describe("chips", () => {
  it("one arrow press steps over a chip, either way", () => {
    const { editor, dom } = composer("a|{{t}}b");
    const before = editor.state.selection.from;
    press(dom, "ArrowRight");
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.from).toBe(before + 1);
    press(dom, "ArrowLeft");
    expect(editor.state.selection).not.toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(before);
  });
});
