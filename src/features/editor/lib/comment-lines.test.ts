import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";

import { commentLinesField, selectedLines, setCommentLines } from "./comment-lines";

/** The lines a Shared Thread file's selection comments on, and the marks open comments leave (ATL-416). */

const DOC = "one\ntwo\nthree\nfour\n";

function at(anchor: number, head: number) {
  return EditorState.create({ doc: DOC, selection: EditorSelection.single(anchor, head) });
}

describe("selectedLines", () => {
  it("is the lines the selection covers, and nothing for a bare caret", () => {
    expect(selectedLines(at(5, 5))).toBeNull();
    expect(selectedLines(at(5, 10))).toEqual({ start: 2, end: 3 });
    // Ending at the very start of a line does not take that line.
    expect(selectedLines(at(4, 8))).toEqual({ start: 2, end: 2 });
    expect(selectedLines(at(10, 5))).toEqual({ start: 2, end: 3 });
  });
});

describe("commentLinesField", () => {
  it("marks each commented line once, and the marks ride their text", () => {
    const state = EditorState.create({ doc: DOC, extensions: [commentLinesField] });
    const marked = state.update({ effects: setCommentLines.of([{ start: 2, end: 3 }, { start: 3, end: 3 }, { start: 9, end: 9 }]) }).state;
    const starts = (s: EditorState) => {
      const out: number[] = [];
      s.field(commentLinesField).between(0, s.doc.length, (from) => {
        out.push(s.doc.lineAt(from).number);
      });
      return out;
    };
    expect(starts(marked)).toEqual([2, 3]);
    const typedAbove = marked.update({ changes: { from: 0, insert: "zero\n" } }).state;
    expect(starts(typedAbove)).toEqual([3, 4]);
  });
});
