import { describe, expect, it } from "vitest";
import { revealStep } from "./jump-reveal";
import { projectRows, RowKind, type Row } from "./turn-rows";
import type { ChatMessage, ToolCallDisplay } from "@/types/agent";

// A comment on a row the transcript has folded away — a call inside a
// collapsed run, a thinking step inside a settled turn's "Worked" section —
// used to land on the fold's header and stop, with the thread unopenable.
// `revealStep` names the folds to open, outer first, until the row shows.

let clock = Date.parse("2026-10-01T09:00:00Z");
const at = () => new Date((clock += 60_000)).toISOString();

const user = (id: string): ChatMessage =>
  ({
    id,
    role: "user",
    content: `q ${id}`,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: at(),
    mode: "text",
  }) as ChatMessage;
const call = (id: string): ToolCallDisplay =>
  ({
    id,
    toolName: "read_file",
    kind: "read",
    status: "completed",
    arguments: { path: `/repo/${id}.ts` },
    result: null,
    duration: null,
    locations: [],
    contentBlocks: [],
  }) as ToolCallDisplay;
const assistant = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage =>
  ({
    id,
    role: "assistant",
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: at(),
    mode: "text",
    ...patch,
  }) as ChatMessage;

/** One settled turn: prompt, thinking, a run of three reads, the answer. */
const messages: ChatMessage[] = [
  user("u1"),
  assistant("a1t", { thinking: "look first" }),
  assistant("a1c", { toolCalls: [call("c1"), call("c2"), call("c3")], mode: "tool" }),
  assistant("a1p", { content: "the answer", workedMs: 4_000 }),
];

function rowsWith(open: Set<string>): Row[] {
  return projectRows(messages, {
    expanded: new Set(),
    expandedTurns: open,
    streaming: false,
    turnInProgress: false,
  }).rows;
}

/** Follow the steps the way the transcript does, re-projecting after each. */
function reveal(target: string, workFoldId: string | undefined) {
  const open = new Set<string>();
  const opened: string[] = [];
  for (let i = 0; i < 4; i++) {
    const step = revealStep(rowsWith(open), target, workFoldId);
    if (step.kind !== "open") return { step, opened };
    opened.push(step.foldId);
    open.add(step.foldId);
  }
  throw new Error("did not converge");
}

const workFold = rowsWith(new Set()).find((r) => r.kind === RowKind.WorkHeader)?.id;

describe("revealStep", () => {
  it("the turn is folded to begin with", () => {
    expect(workFold).toMatch(/^wk:/);
    expect(rowsWith(new Set()).some((r) => r.id === "mk:c2")).toBe(false);
  });

  it("opens the turn, then the run, and lands on the run for a call inside it", () => {
    const { step, opened } = reveal("mk:c2", workFold);
    expect(opened[0]).toBe(workFold);
    expect(opened[1]).toMatch(/^mg:/);
    expect(step).toEqual({ kind: "shown", rowId: opened[1] });
  });

  it("opens only the turn for a thinking step", () => {
    const { step, opened } = reveal("th:a1t", workFold);
    expect(opened).toEqual([workFold]);
    expect(step).toEqual({ kind: "shown", rowId: "th:a1t" });
  });

  it("opens nothing for the answer, which a fold never hides", () => {
    expect(reveal("p:a1p", workFold)).toEqual({
      step: { kind: "shown", rowId: "p:a1p" },
      opened: [],
    });
  });

  it("reports a row the thread does not have", () => {
    const open = new Set([workFold!]);
    expect(revealStep(rowsWith(open), "mk:gone", workFold)).toEqual({ kind: "missing" });
  });
});
