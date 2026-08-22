import { describe, expect, it } from "vitest";
import { collectTurnEdits } from "./turn-edits";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";

const REPO = "/repo";

function toolCall(tc: Partial<ToolCallDisplay>): ToolCallDisplay {
  return {
    id: "tc",
    toolName: "apply_patch",
    status: "completed",
    arguments: {},
    result: null,
    locations: [],
    contentBlocks: [],
    ...tc,
  } as ToolCallDisplay;
}

/** One assistant turn, `t:m1`, made of the given tool calls. */
function turn(...toolCalls: ToolCallDisplay[]): ChatMessage[] {
  return [
    {
      id: "m1",
      role: "assistant",
      content: "",
      toolCalls,
      fileChanges: [],
      plan: null,
      timestamp: "2026-08-23T00:00:00Z",
      mode: "tool",
    } as ChatMessage,
  ];
}

function diffBlock(path: string, oldText: string | undefined, newText: string) {
  return oldText === undefined
    ? { type: "diff" as const, path, newText }
    : { type: "diff" as const, path, oldText, newText };
}

describe("edits reported as ACP diff blocks", () => {
  it("carries the block's before and after text", () => {
    const edits = collectTurnEdits(
      turn(toolCall({ contentBlocks: [diffBlock("/repo/a.ts", "before\n", "after\n")] })),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["a.ts"]);
    expect(edits.sources["a.ts"]).toEqual({ old: "before\n", new: "after\n" });
  });

  it("folds repeat edits to one file as first-before against last-after", () => {
    // The bug this pins: `acp::Diff` carries the WHOLE file either side, not
    // the replaced fragment. Concatenating two of them gave `old = v0 + v1`
    // against `new = v1 + v2` — a diff of the file against a doubled copy of
    // itself, which rendered as every line changed.
    const edits = collectTurnEdits(
      turn(
        toolCall({ id: "tc1", contentBlocks: [diffBlock("/repo/a.ts", "v0\n", "v1\n")] }),
        toolCall({ id: "tc2", contentBlocks: [diffBlock("/repo/a.ts", "v1\n", "v2\n")] }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["a.ts"]);
    expect(edits.sources["a.ts"]).toEqual({ old: "v0\n", new: "v2\n" });
  });

  it("treats an absent before-text as a created file", () => {
    const edits = collectTurnEdits(
      turn(toolCall({ contentBlocks: [diffBlock("/repo/new.ts", undefined, "hello\n")] })),
      "t:m1",
      REPO,
    );
    expect(edits.sources["new.ts"]).toEqual({ old: "", new: "hello\n" });
  });

  it("keeps several files apart, in the order the turn touched them", () => {
    const edits = collectTurnEdits(
      turn(
        toolCall({
          contentBlocks: [
            diffBlock("/repo/b.ts", "b0\n", "b1\n"),
            diffBlock("/repo/a.ts", "a0\n", "a1\n"),
          ],
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.files).toEqual(["b.ts", "a.ts"]);
    expect(edits.sources["a.ts"].new).toBe("a1\n");
    expect(edits.sources["b.ts"].new).toBe("b1\n");
  });
});

describe("edits reported as tool arguments", () => {
  it("still concatenates fragments, which is what Edit arguments carry", () => {
    // Unlike a diff block, an `Edit` names only the text it replaced, so two
    // edits to one file legitimately add up to one fragment pair.
    const edits = collectTurnEdits(
      turn(
        toolCall({
          id: "tc1",
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "one\n", new_string: "ONE\n" },
        }),
        toolCall({
          id: "tc2",
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "two\n", new_string: "TWO\n" },
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.sources["a.ts"]).toEqual({ old: "one\ntwo\n", new: "ONE\nTWO\n" });
  });

  it("prefers the whole file when the same path came both ways", () => {
    // A fragment pair cannot improve on the complete file.
    const edits = collectTurnEdits(
      turn(
        toolCall({
          toolName: "Edit",
          arguments: { file_path: "/repo/a.ts", old_string: "one\n", new_string: "ONE\n" },
          contentBlocks: [diffBlock("/repo/a.ts", "one\ntwo\n", "ONE\ntwo\n")],
        }),
      ),
      "t:m1",
      REPO,
    );
    expect(edits.sources["a.ts"]).toEqual({ old: "one\ntwo\n", new: "ONE\ntwo\n" });
  });
});

describe("which file the viewer lands on", () => {
  const messages = turn(
    toolCall({
      contentBlocks: [
        diffBlock("/repo/b.ts", "b0\n", "b1\n"),
        diffBlock("/repo/a.ts", "a0\n", "a1\n"),
      ],
    }),
  );

  it("is the requested one when the turn touched it", () => {
    expect(collectTurnEdits(messages, "t:m1", REPO, "/repo/a.ts").initial).toBe("a.ts");
  });

  it("falls back to the first file when the requested one is not in the turn", () => {
    expect(collectTurnEdits(messages, "t:m1", REPO, "/repo/z.ts").initial).toBe("b.ts");
  });

  it("is empty for a turn that changed nothing", () => {
    const none = collectTurnEdits(turn(toolCall({ toolName: "Read" })), "t:m1", REPO);
    expect(none).toEqual({ files: [], initial: "", sources: {} });
  });
});
