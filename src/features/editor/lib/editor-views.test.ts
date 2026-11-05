import { describe, expect, it } from "vitest";
import { getEditorPosition, positionOfSelection, registerEditorView } from "./editor-views";

describe("editor position registry", () => {
  it("reads a registered tab's cursor and forgets it on unregister", () => {
    const unregister = registerEditorView("editor:/a.ts", () => ({ cursor: { line: 3, col: 1 } }));
    expect(getEditorPosition("editor:/a.ts")).toEqual({ cursor: { line: 3, col: 1 } });
    unregister();
    expect(getEditorPosition("editor:/a.ts")).toBeUndefined();
  });

  /// A tab remounted before the old view's cleanup ran must not have its new
  /// reader dropped by the stale unregister.
  it("an old unregister does not drop a newer reader for the same tab", () => {
    const dropFirst = registerEditorView("editor:/a.ts", () => ({ cursor: { line: 1, col: 1 } }));
    registerEditorView("editor:/a.ts", () => ({ cursor: { line: 2, col: 1 } }));
    dropFirst();
    expect(getEditorPosition("editor:/a.ts")?.cursor.line).toBe(2);
  });
});

describe("positionOfSelection", () => {
  it("reports a 1-based cursor and no selection when the selection is empty", () => {
    const at = { line: 1, character: 2 };
    expect(positionOfSelection({ start: at, end: at, direction: 0 })).toEqual({
      cursor: { line: 2, col: 3 },
    });
  });

  it("puts the cursor at the selection's caret end", () => {
    const start = { line: 0, character: 1 };
    const end = { line: 2, character: 2 };
    const selection = { from: { line: 1, col: 2 }, to: { line: 3, col: 3 } };
    expect(positionOfSelection({ start, end, direction: 1 })).toEqual({
      cursor: { line: 3, col: 3 },
      selection,
    });
    expect(positionOfSelection({ start, end, direction: -1 })).toEqual({
      cursor: { line: 1, col: 2 },
      selection,
    });
  });
});
