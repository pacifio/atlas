import { describe, expect, it } from "vitest";
import { projectRows, RowKind, type MarkerGroupRow, type MarkerRow } from "./turn-rows";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";

// Markers are folded into one block unless the turn is live or the reader
// opened it; these tests are about the markers, so they open it.
const OPTS = {
  expanded: new Set<string>(),
  streaming: false,
  expandedTurns: new Set<string>(["t:m1"]),
};

function toolCall(tc: Partial<ToolCallDisplay>): ToolCallDisplay {
  return {
    id: "tc1",
    toolName: "write_file",
    status: "completed",
    arguments: {},
    result: null,
    locations: [],
    contentBlocks: [],
    ...tc,
  } as ToolCallDisplay;
}

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

function markers(messages: ChatMessage[]): MarkerRow[] {
  return projectRows(messages, OPTS).rows.filter((r): r is MarkerRow => r.kind === RowKind.Marker);
}

describe("a tool call that reports its edit as a diff content block", () => {
  // The ACP shape: the agent's own tool has whatever name and arguments it
  // likes, and the edit is reported structurally as a `diff` block. Nothing in
  // `arguments` says "this wrote a file", so every marker field has to come
  // from the block — which is what the transcript used to miss entirely.
  const diffCall = toolCall({
    id: "tc-diff",
    toolName: "apply_patch",
    arguments: { patch_id: 7 },
    contentBlocks: [
      {
        type: "diff",
        path: "/repo/src/app.ts",
        oldText: "one\ntwo\n",
        newText: "one\ntwo\nthree\nfour\n",
      },
    ],
  });

  it("opens the diff viewer", () => {
    expect(markers(turn(diffCall))[0].opens).toBe("diff");
  });

  it("names the file it changed", () => {
    const m = markers(turn(diffCall))[0];
    expect(m.verb).toBe("Edited");
    expect(m.detail).toBe("src/app.ts");
    expect(m.path).toBe("/repo/src/app.ts");
  });

  it("counts the lines the block actually changed", () => {
    const m = markers(turn(diffCall))[0];
    expect(m.added).toBe(2);
    expect(m.removed).toBe(0);
  });

  it("reads as Created when the block has no old text", () => {
    const created = toolCall({
      id: "tc-new",
      toolName: "apply_patch",
      contentBlocks: [{ type: "diff", path: "/repo/src/new.ts", newText: "hello\n" }],
    });
    const m = markers(turn(created))[0];
    expect(m.verb).toBe("Created");
    // `oldText` is ABSENT for a created file — the wire skips it rather than
    // sending null (`atlas-agent-wire`), which is what "created" means here.
    expect(m.added).toBe(1);
    expect(m.removed).toBe(0);
  });

  it("still prefers recognisable edit arguments when it has both", () => {
    // A tool Atlas already understands must not change how it reads just
    // because the agent also attached the diff.
    const both = toolCall({
      id: "tc-both",
      toolName: "Write",
      arguments: { file_path: "/repo/src/known.ts", content: "a\n" },
      contentBlocks: [{ type: "diff", path: "/repo/src/other.ts", newText: "z\n" }],
    });
    const m = markers(turn(both))[0];
    expect(m.detail).toBe("src/known.ts");
    expect(m.path).toBe("/repo/src/known.ts");
  });

  it("leaves a terminal block alone — it is output, not a diff", () => {
    const term = toolCall({
      id: "tc-term",
      toolName: "run",
      result: "hello",
      contentBlocks: [{ type: "terminal", terminalId: "t1" }],
    });
    expect(markers(turn(term))[0].opens).toBe("output");
  });

  it("counts a line rewritten twice once, not once per block", () => {
    // `oldText`/`newText` are the WHOLE file either side, so summing blocks
    // counts intermediate states the reader never sees. Rewriting the same
    // line twice is one changed line in the diff they will actually open.
    const twice = toolCall({
      id: "tc-twice",
      contentBlocks: [
        { type: "diff", path: "/repo/src/a.ts", oldText: "a\n", newText: "b\n" },
        { type: "diff", path: "/repo/src/a.ts", oldText: "b\n", newText: "c\n" },
      ],
    });
    const m = markers(turn(twice))[0];
    expect(m.added).toBe(1);
    expect(m.removed).toBe(1);
  });

  it("reads as Edited when the file existed but was empty", () => {
    // The wire OMITS `oldText` for a created file; an empty string means a
    // real file that happened to have no content.
    const emptied = toolCall({
      id: "tc-empty",
      contentBlocks: [{ type: "diff", path: "/repo/src/e.ts", oldText: "", newText: "now\n" }],
    });
    expect(markers(turn(emptied))[0].verb).toBe("Edited");
  });
});

describe("a tool call that ran a terminal", () => {
  it("can be opened before it has printed anything", () => {
    // A running command's marker has to be clickable from the start — the
    // whole point of the output pane is watching it stream in. Keying off
    // `result` made it dead until the first byte arrived.
    const running = toolCall({
      id: "tc-run",
      toolName: "run",
      status: "running",
      result: null,
      contentBlocks: [{ type: "terminal", terminalId: "t1" }],
    });
    expect(markers(turn(running))[0].opens).toBe("output");
  });
});

describe("the folded tool block counts what changed", () => {
  it("counts a file that only a diff block named", () => {
    // The block's "N files" and "+N" come from the markers, so a diff reported
    // structurally has to reach them the same way an Edit does. This is the
    // mechanism the ticket says stays unchanged — it just starts working.
    const rows = projectRows(
      turn(
        toolCall({
          id: "tc-diff",
          toolName: "apply_patch",
          contentBlocks: [{ type: "diff", path: "/repo/a.ts", oldText: "x\n", newText: "y\nz\n" }],
        }),
      ),
      OPTS,
    ).rows;
    const group = rows.find((r): r is MarkerGroupRow => r.kind === RowKind.MarkerGroup);
    expect(group?.modified).toBe(1);
    expect(group?.added).toBe(2);
  });
});
