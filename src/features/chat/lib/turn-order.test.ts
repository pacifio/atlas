import { describe, expect, it } from "vitest";

import type { ChatMessage, ToolCallDisplay } from "@/types/agent";
import { projectRows, RowKind } from "./turn-rows";

// A turn is a sequence of narration and action: "I'm going to check X" → runs a
// command → "that confirmed Y" → runs another → "so the fix is Z". The store
// splits a turn into one message per block precisely so it can be replayed in
// event order — `ChatMessage.mode` exists for that.
//
// If the projection hoists every tool call to one point in the turn, the reader
// loses the thing that makes a transcript legible: which narration goes with
// which action.

let seq = 0;
function tool(name: string, kind: string, args: Record<string, unknown> = {}): ToolCallDisplay {
  seq += 1;
  return {
    id: `tc${seq}`,
    toolName: name,
    kind,
    arguments: args,
    result: "ok",
    status: "completed",
    duration: 10,
  };
}

function msg(part: Partial<ChatMessage> & { id: string; role: ChatMessage["role"] }): ChatMessage {
  return {
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-08-19T09:00:00.000Z",
    ...part,
  } as ChatMessage;
}

/** The thread a real turn produces: narrate, act, narrate, act, narrate. */
function interleavedTurn(): ChatMessage[] {
  return [
    msg({ id: "u1", role: "user", content: "fix the thing" }),
    msg({ id: "a1", role: "assistant", mode: "text", content: "First I'll check the config." }),
    msg({
      id: "a2",
      role: "assistant",
      mode: "tool",
      toolCalls: [tool("Read", "read", { file_path: "src/a.rs" })],
    }),
    msg({ id: "a3", role: "assistant", mode: "text", content: "That confirmed the bug." }),
    msg({
      id: "a4",
      role: "assistant",
      mode: "tool",
      toolCalls: [tool("Edit", "edit", { file_path: "src/a.rs" })],
    }),
    msg({ id: "a5", role: "assistant", mode: "text", content: "Fixed. Running the tests." }),
    msg({
      id: "a6",
      role: "assistant",
      mode: "tool",
      toolCalls: [tool("cargo test", "execute", { command: "cargo test" })],
    }),
    msg({ id: "a7", role: "assistant", mode: "text", content: "All green." }),
  ];
}

const opts = {
  expanded: new Set<string>(),
  expandedGroups: new Set<string>(["mg:t:a1:0", "mg:t:a1:1", "mg:t:a1:2"]),
};

describe("transcript ordering", () => {
  it("keeps narration and the action it describes in the order they happened", () => {
    const { rows } = projectRows(interleavedTurn(), { ...opts, streaming: false });

    // Reduce to the shape a reader perceives: prose text, or a tool marker.
    const shape = rows
      .filter((r) => r.kind === RowKind.Prose || r.kind === RowKind.Marker)
      .map((r) => (r.kind === RowKind.Prose ? r.text : `<${r.verb}>`));

    expect(shape).toEqual([
      "First I'll check the config.",
      "<Read>",
      "That confirmed the bug.",
      "<Edited>",
      "Fixed. Running the tests.",
      "<Ran>",
      "All green.",
    ]);
  });

  it("does not hoist a later action above earlier narration", () => {
    const { rows } = projectRows(interleavedTurn(), { ...opts, streaming: false });
    const firstMarker = rows.findIndex((r) => r.kind === RowKind.Marker);
    const lastProse = rows.map((r) => r.kind).lastIndexOf(RowKind.Prose);
    expect(firstMarker).toBeGreaterThan(-1);
    expect(lastProse).toBeGreaterThan(firstMarker);

    // The prose that preceded the very first tool call must still precede it.
    const proseBefore = rows.slice(0, firstMarker).filter((r) => r.kind === RowKind.Prose).length;
    expect(proseBefore).toBe(1);
  });
});

describe("run grouping", () => {
  it("folds a run of consecutive calls into one labelled block", () => {
    const msgs: ChatMessage[] = [
      msg({ id: "u1", role: "user", content: "go" }),
      msg({ id: "a1", role: "assistant", mode: "text", content: "Checking a few things." }),
      msg({
        id: "a2",
        role: "assistant",
        mode: "tool",
        toolCalls: [
          tool("cargo test", "execute", { command: "cargo test" }),
          tool("cargo clippy", "execute", { command: "cargo clippy" }),
          tool("Read", "read", { file_path: "src/a.rs" }),
        ],
      }),
      msg({ id: "a3", role: "assistant", mode: "text", content: "Done." }),
    ];
    const { rows } = projectRows(msgs, {
      expanded: new Set(),
      expandedGroups: new Set(),
      streaming: false,
    });
    const groups = rows.filter((r) => r.kind === RowKind.MarkerGroup);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    // Names the work rather than counting it, and the biggest kind leads.
    expect(groups[0].summary).toBe("Ran 2 shell commands, read 1 file");
    // Folded: the members are not rows until the reader opens the block.
    expect(rows.filter((r) => r.kind === RowKind.Marker)).toHaveLength(0);
  });

  it("gives each run its own block so they can be opened independently", () => {
    const { rows } = projectRows(interleavedTurn(), { ...opts, streaming: false });
    const ids = rows.filter((r) => r.kind === RowKind.MarkerGroup).map((r) => r.id);
    expect(ids).toEqual(["mg:t:a1:0", "mg:t:a1:1", "mg:t:a1:2"]);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps the live run open and folds the ones already finished", () => {
    // While a turn streams, the trailing run is the progress report. Earlier
    // runs are history and fold like any other.
    const msgs = interleavedTurn();
    msgs.pop(); // drop the closing prose so the turn ends on a tool run
    const { rows } = projectRows(msgs, {
      expanded: new Set(),
      expandedGroups: new Set(),
      streaming: true,
    });
    const groups = rows.filter((r) => r.kind === RowKind.MarkerGroup);
    expect(groups.map((g) => g.running)).toEqual([false, false, true]);
    expect(groups.map((g) => g.open)).toEqual([false, false, true]);
  });

  it("names a fourth kind's count rather than a fourth clause", () => {
    const many = Array.from({ length: 11 }, (_, k) =>
      k < 4
        ? tool("sh", "execute", { command: "ls" })
        : k < 7
          ? tool("Read", "read", { file_path: `src/f${k}.rs` })
          : k < 9
            ? tool("Grep", "search", { pattern: "x" })
            : tool("Edit", "edit", { file_path: `src/e${k}.rs` }),
    );
    const msgs: ChatMessage[] = [
      msg({ id: "u1", role: "user", content: "go" }),
      msg({ id: "a1", role: "assistant", mode: "tool", toolCalls: many }),
    ];
    const { rows } = projectRows(msgs, { ...opts, streaming: false });
    const group = rows.find((r) => r.kind === RowKind.MarkerGroup);
    expect(group?.summary).toBe("Ran 4 shell commands, read 3 files, searched 2 patterns +2 more");
  });
});

describe("summary casing", () => {
  it("keeps a tool's own name capitalised", () => {
    // The transcript rendered "TerminalWrite 6×, terminalStart 1×" — the
    // sentence-casing pass could not tell a verb from a tool name.
    const msgs: ChatMessage[] = [
      msg({ id: "u1", role: "user", content: "start the dev" }),
      msg({
        id: "a1",
        role: "assistant",
        mode: "tool",
        toolCalls: [
          tool("TerminalStart", "other", {}),
          tool("TerminalWrite", "other", {}),
          tool("TerminalWrite", "other", {}),
        ],
      }),
    ];
    const { rows } = projectRows(msgs, {
      expanded: new Set(),
      expandedGroups: new Set(),
      streaming: false,
    });
    const group = rows.find((r) => r.kind === RowKind.MarkerGroup);
    expect(group?.summary).toBe("TerminalWrite 2×, TerminalStart 1×");
  });

  it("still lower-cases a trailing verb clause", () => {
    const msgs: ChatMessage[] = [
      msg({ id: "u1", role: "user", content: "go" }),
      msg({
        id: "a1",
        role: "assistant",
        mode: "tool",
        toolCalls: [
          tool("sh", "execute", { command: "ls" }),
          tool("sh", "execute", { command: "pwd" }),
          tool("Read", "read", { file_path: "a.rs" }),
        ],
      }),
    ];
    const { rows } = projectRows(msgs, {
      expanded: new Set(),
      expandedGroups: new Set(),
      streaming: false,
    });
    const group = rows.find((r) => r.kind === RowKind.MarkerGroup);
    expect(group?.summary).toBe("Ran 2 shell commands, read 1 file");
  });
});
