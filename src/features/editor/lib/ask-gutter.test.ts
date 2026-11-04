// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";

import { askAgentGutter, askLinesAt, excerptOf } from "./ask-gutter";

const DOC = "one\ntwo\nthree\nfour\nfive";

/** ⌘↵ on a Mac, Ctrl+↵ elsewhere: CodeMirror's `Mod-Enter` as this
 *  environment's platform reads it. */
function modEnter(): KeyboardEvent {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return new KeyboardEvent("keydown", { key: "Enter", metaKey: mac, ctrlKey: !mac });
}

function stateWith(anchor: number, head = anchor): EditorState {
  return EditorState.create({ doc: DOC, selection: EditorSelection.single(anchor, head) });
}

describe("askLinesAt", () => {
  it("is the cursor's line with nothing selected", () => {
    expect(askLinesAt(stateWith(5))).toEqual({ from: 2, to: 2 });
  });

  it("is the selection's lines, either way it was drawn", () => {
    expect(askLinesAt(stateWith(1, 10))).toEqual({ from: 1, to: 3 });
    expect(askLinesAt(stateWith(10, 1))).toEqual({ from: 1, to: 3 });
  });

  it("leaves out the line a whole-line selection ends at the start of", () => {
    // "two\n" selected: ends at the start of line 3.
    expect(askLinesAt(stateWith(4, 8))).toEqual({ from: 2, to: 2 });
  });

  it("asks about a hovered line inside the selection as the selection", () => {
    expect(askLinesAt(stateWith(1, 10), 2)).toEqual({ from: 1, to: 3 });
  });

  it("asks about a hovered line outside the selection as that line", () => {
    expect(askLinesAt(stateWith(1, 10), 5)).toEqual({ from: 5, to: 5 });
  });
});

describe("excerptOf", () => {
  it("is the lines' whole text, without the last line break", () => {
    expect(excerptOf(stateWith(0).doc, { from: 2, to: 3 })).toBe("two\nthree");
  });
});

describe("⌘↵", () => {
  it("asks about the selection, read-only or not, ahead of the default keymap", () => {
    const onAsk = vi.fn();
    const view = new EditorView({
      state: EditorState.create({
        doc: DOC,
        selection: EditorSelection.single(4, 11),
        extensions: [askAgentGutter(() => onAsk), EditorState.readOnly.of(true)],
      }),
      parent: document.body,
    });
    const handled = runScopeHandlers(view, modEnter(), "editor");
    expect(handled).toBe(true);
    expect(onAsk).toHaveBeenCalledTimes(1);
    const [lines, excerpt, anchor] = onAsk.mock.calls[0];
    expect(lines).toEqual({ from: 2, to: 3 });
    expect(excerpt).toBe("two\nthree");
    expect(anchor).toBeInstanceOf(DOMRect);
    view.destroy();
  });

  it("is left to the editor when nothing listens", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: DOC, extensions: [askAgentGutter(() => undefined)] }),
      parent: document.body,
    });
    const handled = runScopeHandlers(view, modEnter(), "editor");
    expect(handled).toBe(false);
    view.destroy();
  });
});
