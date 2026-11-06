// Delegating turns project to subagent rows, not tool markers.
//
// Three facts this pins, none of which fails visibly:
//   * the launching call stops being a marker (otherwise it folds into
//     "Loaded tools" and the reader never learns an agent was spawned);
//   * a child's own calls leave the turn's stream (otherwise they read as the
//     parent's work, and three children interleave into one block nobody can
//     attribute);
//   * a session that delegated nothing projects exactly as it did before.

import { describe, expect, it } from "vitest";

import { projectRows, RowKind, type ProjectOptions, type SubagentRow } from "./turn-rows";
import type { ChatMessage, Subagent, ToolCallDisplay } from "@/types/agent";

const OPEN_WORK = "wk:t:m1";

const OPTS: ProjectOptions = {
  expanded: new Set<string>(),
  streaming: false,
  expandedTurns: new Set<string>([OPEN_WORK]),
};

function toolCall(tc: Partial<ToolCallDisplay> & Pick<ToolCallDisplay, "id">): ToolCallDisplay {
  return {
    toolName: "read_file",
    status: "completed",
    arguments: {},
    result: null,
    locations: [],
    contentBlocks: [],
    ...tc,
  } as ToolCallDisplay;
}

function child(over: Partial<Subagent> & Pick<Subagent, "toolCallId">): Subagent {
  return {
    messageId: "m1",
    name: "counter",
    status: "running",
    toolCallCount: 0,
    startedAtMs: 1000,
    ...over,
  };
}

function turn(toolCalls: ToolCallDisplay[], second: ToolCallDisplay[] = []): ChatMessage[] {
  const message = (id: string, calls: ToolCallDisplay[]): ChatMessage =>
    ({
      id,
      role: "assistant",
      content: "",
      toolCalls: calls,
      fileChanges: [],
      plan: null,
      timestamp: "2026-10-17T00:00:00Z",
      mode: "tool",
    }) as ChatMessage;
  return second.length > 0
    ? [message("m1", toolCalls), message("m2", second)]
    : [message("m1", toolCalls)];
}

function rowsOf(messages: ChatMessage[], opts: Partial<ProjectOptions> = {}) {
  return projectRows(messages, { ...OPTS, ...opts }).rows;
}

function subagentRows(messages: ChatMessage[], opts: Partial<ProjectOptions> = {}): SubagentRow[] {
  return rowsOf(messages, opts).filter((r): r is SubagentRow => r.kind === RowKind.Subagent);
}

const LAUNCH = toolCall({ id: "task-a", toolName: "Task" });

describe("a launching call becomes the child it launched", () => {
  const subagents = { "task-a": child({ toolCallId: "task-a", prompt: "count the files" }) };

  it("projects a subagent row carrying the child, not the call", () => {
    const [row] = subagentRows(turn([LAUNCH]), { subagents });
    expect(row).toMatchObject({
      toolCallId: "task-a",
      name: "counter",
      status: "running",
      prompt: "count the files",
      startedAt: 1000,
      workCount: 0,
    });
  });

  it("keeps it out of the folded tool block", () => {
    // Folded, the row reads "loaded a tool" — which is what the native agent's
    // children looked like before this existed.
    const rows = rowsOf(turn([LAUNCH]), { subagents });
    expect(rows.some((r) => r.kind === RowKind.MarkerGroup)).toBe(false);
  });

  it("falls back to a name when the agent sent none", () => {
    const [row] = subagentRows(turn([LAUNCH]), {
      subagents: { "task-a": child({ toolCallId: "task-a", name: "  " }) },
    });
    expect(row.name).toBe("Subagent");
  });
});

describe("a child's own calls", () => {
  it("neither count as the parent's work nor fail its turn", () => {
    // A child's failed grep is the child's failure. Counted on the parent it
    // turned the whole turn red and inflated its tool count with work the
    // parent never did.
    const { turns } = projectRows(
      turn(
        [LAUNCH, toolCall({ id: "own" })],
        [toolCall({ id: "c1", toolName: "grep", status: "failed", parentToolCallId: "task-a" })],
      ),
      { ...OPTS, subagents: { "task-a": child({ toolCallId: "task-a" }) } },
    );
    expect(turns[0].status).toBe("settled");
    expect(turns[0].toolCount).toBe(2);
  });

  const subagents = {
    "task-a": child({ toolCallId: "task-a", toolCallCount: 2 }),
  };
  const messages = turn(
    [LAUNCH, toolCall({ id: "own", toolName: "write_file" })],
    [
      toolCall({ id: "c1", toolName: "grep", parentToolCallId: "task-a" }),
      toolCall({ id: "c2", toolName: "read_file", parentToolCallId: "task-a" }),
    ],
  );

  it("hang under their parent's row, not in the turn's stream", () => {
    const [row] = subagentRows(messages, { subagents });
    expect(row.markers.map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
    expect(row.workCount).toBe(2);

    const streamed = rowsOf(messages, { subagents }).flatMap((r) =>
      r.kind === RowKind.MarkerGroup
        ? r.markers.map((m) => m.toolCallId)
        : r.kind === RowKind.Marker
          ? [r.toolCallId]
          : [],
    );
    expect(streamed).toEqual(["own"]);
  });

  it("are collected even when they arrive in a later message than the launch", () => {
    // The agent announces a call and attributes it afterwards, so a per-launch
    // lookup over earlier messages would miss them.
    const [row] = subagentRows(messages, { subagents });
    expect(row.markers).toHaveLength(2);
  });

  it("stay in the stream when their named parent is not a known child", () => {
    // An agent that stamps `parentToolCallId` for something Atlas did not read
    // as a launch must not have its calls silently swallowed.
    const orphan = turn([toolCall({ id: "x", parentToolCallId: "nobody" })]);
    const streamed = rowsOf(orphan, { subagents }).flatMap((r) =>
      r.kind === RowKind.MarkerGroup
        ? r.markers.map((m) => m.toolCallId)
        : r.kind === RowKind.Marker
          ? [r.toolCallId]
          : [],
    );
    expect(streamed).toEqual(["x"]);
  });
});

describe("a mail child, whose work is never attributed", () => {
  it("reports no work rather than an empty list of it", () => {
    // The native engine's children run on their own threads: 0 means "not
    // visible here", and a row that says "0 tools" would be stating a untruth.
    const [row] = subagentRows(turn([LAUNCH]), {
      subagents: {
        "task-a": child({
          toolCallId: "task-a",
          status: "completed",
          result: "92 files",
          endedAtMs: 4000,
          toolCallCount: 0,
        }),
      },
    });
    expect(row.workCount).toBe(0);
    expect(row.markers).toEqual([]);
    expect(row.result).toBe("92 files");
    expect(row.endedAt).toBe(4000);
  });
});

describe("the fold", () => {
  it("leaves subagent rows visible on a settled turn", () => {
    // A folded turn hides what it DID; a child is not that. It has its own
    // state, it can outlive the turn, and it is the one thing a delegating
    // turn exists to report — folded away, the turn reads as "Worked ›" and
    // nothing else.
    const rows = rowsOf(turn([LAUNCH, toolCall({ id: "own" })]), {
      subagents: { "task-a": child({ toolCallId: "task-a", status: "completed" }) },
      // The work block is CLOSED here, unlike every other case in this file.
      expandedTurns: new Set<string>(),
    });
    expect(rows.some((r) => r.kind === RowKind.WorkHeader)).toBe(true);
    expect(rows.filter((r) => r.kind === RowKind.Subagent)).toHaveLength(1);
    // The parent's own call still folds away.
    expect(rows.some((r) => r.kind === RowKind.MarkerGroup)).toBe(false);
  });
});

describe("a session that delegated nothing", () => {
  it("projects exactly as before — no rows, no attribution pass", () => {
    const rows = rowsOf(turn([LAUNCH, toolCall({ id: "own" })]));
    expect(rows.some((r) => r.kind === RowKind.Subagent)).toBe(false);
    const streamed = rows.flatMap((r) =>
      r.kind === RowKind.MarkerGroup
        ? r.markers.map((m) => m.toolCallId)
        : r.kind === RowKind.Marker
          ? [r.toolCallId]
          : [],
    );
    expect(streamed).toEqual(["task-a", "own"]);
  });
});
