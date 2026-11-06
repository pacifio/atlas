import { describe, expect, it } from "vitest";
import { quoteLines, selectionCommentBody, splitSelectionComment } from "./selection-comment";

describe("selection comments on existing message anchors", () => {
  it("round-trips a selected passage, code indentation and blank lines after reload", () => {
    const selection = "  const answer = 42;\n\nreturn answer;  ";
    expect(splitSelectionComment(selectionCommentBody(selection, "Please explain this."))).toEqual({
      selection,
      body: "Please explain this.",
    });
  });
  it("does not turn quoted agent mentions into new server-side notifications", () => {
    const stored = selectionCommentBody("Ask <@usr_sam> &amp; <example>", "Agree, <@usr_tobi>?");
    expect(stored.match(/<@[^>]+>/g)).toEqual(["<@usr_tobi>"]);
    expect(splitSelectionComment(stored)?.selection).toBe("Ask <@usr_sam> &amp; <example>");
  });
  it("keeps different passages separate inside the same message thread", () => {
    expect(splitSelectionComment(selectionCommentBody("First passage", "one"))?.selection).not.toBe(
      splitSelectionComment(selectionCommentBody("Second passage", "two"))?.selection,
    );
  });
  it("leaves older plain comments and malformed excerpt prefixes alone", () => {
    expect(splitSelectionComment("An existing comment")).toBeNull();
    expect(splitSelectionComment("Selected passage:\n\nNot quoted\n\nComment")).toBeNull();
  });
  it("quotes every line without trimming the selected text", () => {
    expect(quoteLines("one\r\n\r\n  two ")).toBe("> one\n> \n>   two ");
  });
});
