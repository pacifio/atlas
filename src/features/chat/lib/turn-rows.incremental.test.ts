import { describe, expect, it } from "vitest";
import { projectRows, RowKind, type ProjectOptions, type Projection } from "./turn-rows";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";

// `projectRows` re-uses the previous projection's turns when their inputs are
// unchanged. These tests hold it to one contract: the incremental projection
// is indistinguishable from projecting the same thread from scratch, and the
// turns that did not change come back as the same objects.

let clock = Date.parse("2026-10-01T09:00:00Z");
function at(minutes = 1): string {
  clock += minutes * 60_000;
  return new Date(clock).toISOString();
}

function user(id: string, content: string, minutes = 1): ChatMessage {
  return {
    id,
    role: "user",
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: at(minutes),
    mode: "text",
  } as ChatMessage;
}

function call(id: string, status: ToolCallDisplay["status"] = "completed"): ToolCallDisplay {
  return {
    id,
    toolName: "read_file",
    kind: "read",
    status,
    arguments: { path: `/repo/src/${id}.ts` },
    result: null,
    duration: null,
    locations: [],
    contentBlocks: [],
  } as ToolCallDisplay;
}

function assistant(id: string, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: at(),
    mode: "text",
    ...patch,
  } as ChatMessage;
}

/** A settled exchange: prompt, thinking, two reads, an answer. */
function exchange(n: number): ChatMessage[] {
  return [
    user(`u${n}`, `question ${n}`),
    assistant(`a${n}t`, { thinking: `thinking about ${n}` }),
    assistant(`a${n}c`, { toolCalls: [call(`c${n}a`), call(`c${n}b`)], mode: "tool" }),
    assistant(`a${n}p`, { content: `answer ${n}`, workedMs: 4_000 }),
  ];
}

// Shared, as the transcript holds them: a new set is a real change of input
// and would re-project every turn, hiding exactly what these tests check.
const EXPANDED = new Set<string>();
const EXPANDED_TURNS = new Set<string>();

function opts(patch: Partial<ProjectOptions> = {}): ProjectOptions {
  return { expanded: EXPANDED, expandedTurns: EXPANDED_TURNS, streaming: false, ...patch };
}

/** What a reader can observe: rows and turns, not the reuse bookkeeping. */
function visible(p: Projection) {
  return { rows: p.rows, turns: p.turns };
}

/** Project incrementally from `prev` and check it against a fresh projection. */
function step(messages: ChatMessage[], o: ProjectOptions, prev: Projection | null): Projection {
  const next = projectRows(messages, o, prev);
  expect(visible(next)).toEqual(visible(projectRows(messages, o)));
  return next;
}

describe("incremental projection", () => {
  it("re-projects only the streaming turn and matches a fresh projection", () => {
    const history = [1, 2, 3, 4, 5].flatMap(exchange);
    let messages = [...history, user("u6", "go"), assistant("a6", { content: "" })];
    const o = opts({ streaming: true, turnInProgress: true });
    let prev = step(messages, o, null);
    const settledRows = prev.rows.filter((r) => !r.turnId.endsWith("a6"));
    const settledSegments = prev.segments.slice(0, -1);

    let text = "";
    for (let k = 0; k < 20; k++) {
      text += `chunk ${k} `;
      messages = [...messages.slice(0, -1), { ...messages[messages.length - 1], content: text }];
      prev = step(messages, o, prev);
    }
    // Every row of the settled turns is the very object the first projection
    // made: nothing above the live turn re-rendered.
    for (const row of settledRows) {
      expect(prev.rows.find((r) => r.id === row.id)).toBe(row);
    }
    // And they were not projected again to get there: the turns themselves
    // came back untouched.
    expect(prev.segments.slice(0, -1)).toEqual(settledSegments);
    prev.segments.slice(0, -1).forEach((s, k) => expect(s).toBe(settledSegments[k]));
  });

  it("keeps a settled turn's changed-files row, and its files array, while another streams", () => {
    const files = [{ path: "/repo/src/a.ts", kind: "edit" as const, added: 2, removed: 1 }];
    const settled = [
      user("u1", "edit it"),
      assistant("a1", {
        content: "done",
        workedMs: 1_000,
        turnSummary: { turnSeq: 1, files, repoAtTurn: false },
      }),
    ];
    let messages = [...settled, user("u2", "go"), assistant("a2", { content: "" })];
    const o = opts({ streaming: true, turnInProgress: true });
    let prev = step(messages, o, null);
    const footer = prev.rows.find((r) => r.kind === RowKind.TurnFooter);
    expect(footer && "files" in footer && footer.files).toBe(files);
    for (let k = 0; k < 5; k++) {
      const tail = messages[messages.length - 1];
      messages = [...messages.slice(0, -1), { ...tail, content: `${tail.content} more` }];
      prev = step(messages, o, prev);
    }
    // The same row object: its card's memo sees nothing new and does not render.
    expect(prev.rows.find((r) => r.kind === RowKind.TurnFooter)).toBe(footer);
  });

  it("keys a turn's footer by its first edit's call id, which a reload keeps", () => {
    const files = [{ path: "/repo/src/a.ts", kind: "edit" as const, added: 1, removed: 0 }];
    const edit = { ...call("e1"), toolName: "Edit", kind: "edit" } as ToolCallDisplay;
    // A reload re-mints every message id; the agent's call ids survive it.
    const load = (prefix: string) => [
      user(`${prefix}u`, "edit it"),
      assistant(`${prefix}a0`, { content: "\n\n" }),
      assistant(`${prefix}a1`, { toolCalls: [call("r1"), edit], mode: "tool" }),
      assistant(`${prefix}a2`, {
        content: "done",
        turnSummary: { turnSeq: 1, files, repoAtTurn: false },
      }),
    ];
    const keyOf = (messages: ChatMessage[]) => {
      const footer = step(messages, opts(), null).rows.find((r) => r.kind === RowKind.TurnFooter);
      return footer && "turnKey" in footer ? footer.turnKey : null;
    };
    expect(keyOf(load("x"))).toBe("tc:e1");
    expect(keyOf(load("y"))).toBe("tc:e1");
  });

  it("follows a tool call through pending, running and done", () => {
    let messages = [...exchange(1), user("u2", "go"), assistant("a2", { mode: "tool" })];
    const o = opts({ streaming: true, turnInProgress: true });
    let prev = step(messages, o, null);
    for (const status of ["pending", "running", "completed"] as const) {
      const tail = messages[messages.length - 1];
      messages = [...messages.slice(0, -1), { ...tail, toolCalls: [call("live", status)] }];
      prev = step(messages, o, prev);
    }
  });

  it("settles the live turn when the stream ends", () => {
    const messages = [...exchange(1), user("u2", "go"), assistant("a2", { content: "done" })];
    const prev = step(messages, opts({ streaming: true, turnInProgress: true }), null);
    step(messages, opts(), prev);
  });

  it("starts a new turn, with its gap separator, after a long pause", () => {
    const messages = exchange(1);
    const prev = step(messages, opts(), null);
    const next = step([...messages, user("u2", "back again", 45)], opts(), prev);
    expect(next.rows.some((r) => r.id === "gs:u2")).toBe(true);
  });

  it("re-indexes reused turns when older history loads above them", () => {
    const older = exchange(1);
    const newer = [...exchange(2), ...exchange(3)];
    const prev = step(newer, opts(), null);
    const next = step([...older, ...newer], opts(), prev);
    expect(next.turns.map((t) => t.messageIndex)).toEqual(
      projectRows([...older, ...newer], opts()).turns.map((t) => t.messageIndex),
    );
  });

  it("re-projects when the reader opens a turn's work", () => {
    const messages = [...exchange(1), ...exchange(2)];
    const prev = step(messages, opts(), null);
    step(messages, opts({ expandedTurns: new Set(["wk:t:a1t"]) }), prev);
  });

  it("drops a turn's children when the session's subagents are cleared", () => {
    const messages = [
      user("u1", "delegate"),
      assistant("a1", { toolCalls: [call("launch")], mode: "tool" }),
      assistant("a2", { content: "done" }),
    ];
    const child = {
      name: "helper",
      status: "completed",
      prompt: "",
      result: null,
      toolCallCount: 0,
    } as unknown as NonNullable<ProjectOptions["subagents"]>[string];
    const prev = step(messages, opts({ subagents: { launch: child } }), null);
    step(messages, opts(), prev);
  });

  it("handles a rewind that drops the last turn", () => {
    const messages = [...exchange(1), ...exchange(2)];
    const prev = step(messages, opts(), null);
    step(messages.slice(0, 4), opts(), prev);
  });
});

describe("a thinking row", () => {
  const thinking = (expanded: ReadonlySet<string>) =>
    projectRows(
      [
        user("u1", "go"),
        assistant("t1", { thinking: "**Checking the cache key**\n\nThe key holds ids." }),
      ],
      opts({ streaming: true, turnInProgress: true, expanded }),
    ).rows.find((r) => r.kind === RowKind.Thinking);

  it("carries its headline, and its text only when open", () => {
    expect(thinking(EXPANDED)).toMatchObject({ headline: "Checking the cache key", text: "" });
    expect(thinking(new Set(["th:t1"]))).toMatchObject({
      text: "**Checking the cache key**\n\nThe key holds ids.",
    });
  });
});
