import { describe, expect, it } from "vitest";

import { countEditLines, isFileCreated } from "./tool-files";

// File-change accounting had one source: guessing the tool's argument shape.
// That reads zero for any tool whose arguments `getEditParts` does not
// recognise, and zero is indistinguishable from "nothing changed" — the counts
// were wrong with nothing erroring. Tools now report a real before/after, and
// these tests pin the precedence between the two.

describe("countEditLines", () => {
  it("uses the diff the tool reported when there is one", () => {
    const counts = countEditLines(
      "Edit",
      {},
      { path: "/p/a.rs", oldText: "a\nb\nc\n", newText: "a\nB\nC\nd\n" },
    );
    expect(counts).toEqual({ added: 3, removed: 2 });
  });

  it("prefers the reported diff over the arguments when both are present", () => {
    // The arguments describe a one-line change; the tool reports a three-line
    // one. The tool is the authority — it is what actually touched the file.
    const counts = countEditLines(
      "Edit",
      { old_string: "x", new_string: "y" },
      { path: "/p/a.rs", oldText: "1\n2\n3\n", newText: "one\ntwo\nthree\n" },
    );
    expect(counts).toEqual({ added: 3, removed: 3 });
  });

  it("falls back to the arguments when no diff was reported", () => {
    // Replay from a stored transcript carries no diff, so the fallback has to
    // keep working.
    expect(countEditLines("Edit", { old_string: "a\nb\n", new_string: "a\nB\n" })).toEqual({
      added: 1,
      removed: 1,
    });
  });

  it("reads a batched Edit's arguments when no diff was reported", () => {
    // Cersei's Edit absorbed the old MultiEdit tool, so `edits[]` now arrives
    // under the name `Edit`. A replayed transcript carries no diff, so the
    // argument fallback has to recognise the array whatever the tool is called.
    expect(
      countEditLines("Edit", {
        edits: [
          { old_string: "a\n", new_string: "A\n" },
          { old_string: "b\n", new_string: "B\n" },
        ],
      }),
    ).toEqual({ added: 2, removed: 2 });
  });

  it("reports nothing for a tool whose arguments it cannot read and that reported no diff", () => {
    expect(countEditLines("SomeMcpTool", { patch: "@@ -1 +1 @@" })).toEqual({
      added: 0,
      removed: 0,
    });
  });

  it("counts a creation as pure additions", () => {
    expect(countEditLines("Write", {}, { path: "/p/new.rs", newText: "one\ntwo\n" })).toEqual({
      added: 2,
      removed: 0,
    });
  });
});

describe("isFileCreated", () => {
  it("reads creation off the reported diff", () => {
    expect(isFileCreated("Edit", {}, { path: "/p/a.rs", newText: "x" })).toBe(true);
    expect(isFileCreated("Edit", {}, { path: "/p/a.rs", oldText: "", newText: "x" })).toBe(true);
    expect(isFileCreated("Edit", {}, { path: "/p/a.rs", oldText: "old", newText: "x" })).toBe(
      false,
    );
  });

  it("still works from arguments alone", () => {
    expect(isFileCreated("Edit", { old_string: "", new_string: "x" })).toBe(true);
    expect(isFileCreated("Edit", { old_string: "old", new_string: "x" })).toBe(false);
  });
});
