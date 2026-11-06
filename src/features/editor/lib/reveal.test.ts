import { describe, expect, it } from "vitest";
import { revealSelection } from "./reveal";

describe("revealSelection", () => {
  it("puts the caret at the start of a 1-based line", () => {
    expect(revealSelection({ line: 2 })).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 0 },
      direction: "none",
    });
  });

  it("honours a 1-based column", () => {
    expect(revealSelection({ line: 4, column: 3 }).start).toEqual({ line: 3, character: 2 });
  });

  /// The agent reads line numbers off stale output; nothing below 1 may reach
  /// the editor as a negative position (it clamps the top end itself).
  it("clamps a line or column below 1 to the start", () => {
    expect(revealSelection({ line: 0, column: -4 }).start).toEqual({ line: 0, character: 0 });
  });

  it("selects to the end of the end line when no end column is given", () => {
    const at = revealSelection({ line: 1, endLine: 2 });
    expect(at.end.line).toBe(1);
    expect(at.end.character).toBe(Number.MAX_SAFE_INTEGER);
    expect(at.direction).toBe("forward");
  });

  it("selects to an end column when one is given", () => {
    expect(revealSelection({ line: 1, column: 2, endLine: 4, endColumn: 5 })).toEqual({
      start: { line: 0, character: 1 },
      end: { line: 3, character: 4 },
      direction: "forward",
    });
  });
});
