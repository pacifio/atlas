import { describe, expect, it } from "vitest";

import {
  childCallsByParent,
  childCallsOf,
  displayName,
  elapsedMs,
  hasAttributedWork,
  isRunning,
  isTerminal,
  launchCallIds,
  orderedSubagents,
  subagentsOfMessage,
  tallySubagents,
} from "./subagents";
import type { ChatMessage, Subagent, ToolCallDisplay } from "@/types/agent";

function subagent(over: Partial<Subagent> & Pick<Subagent, "toolCallId">): Subagent {
  return {
    messageId: "m1",
    name: "counter",
    status: "running",
    toolCallCount: 0,
    startedAtMs: 1000,
    ...over,
  };
}

function call(over: Partial<ToolCallDisplay> & Pick<ToolCallDisplay, "id">): ToolCallDisplay {
  return {
    toolName: "read",
    kind: "read",
    arguments: {},
    result: null,
    status: "completed",
    duration: null,
    ...over,
  } as ToolCallDisplay;
}

function message(id: string, toolCalls: ToolCallDisplay[]): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls,
    fileChanges: [],
    plan: null,
    timestamp: new Date(0).toISOString(),
  } as ChatMessage;
}

describe("orderedSubagents", () => {
  it("is launch order, not the order updates arrived in", () => {
    // The map is keyed by launch id and written on every upsert, so its key
    // order is arrival order: a child that finishes first would otherwise
    // overtake the one spawned before it, and a row would move while read.
    const map: Record<string, Subagent> = {
      b: subagent({ toolCallId: "b", startedAtMs: 2000, name: "greeter" }),
      a: subagent({ toolCallId: "a", startedAtMs: 1000 }),
    };
    expect(orderedSubagents(map).map((s) => s.toolCallId)).toEqual(["a", "b"]);
  });

  it("breaks a shared millisecond on the launch id, so the order is total", () => {
    // Two `spawn_agent` calls in one stream frame share a timestamp; without
    // the tiebreak the sort is unstable across re-projections and rows swap.
    const map: Record<string, Subagent> = {
      z: subagent({ toolCallId: "z", startedAtMs: 1000 }),
      a: subagent({ toolCallId: "a", startedAtMs: 1000 }),
    };
    expect(orderedSubagents(map).map((s) => s.toolCallId)).toEqual(["a", "z"]);
    expect(orderedSubagents(undefined)).toEqual([]);
  });
});

describe("status", () => {
  it("treats interrupted as terminal but not as failure", () => {
    // Stop cascades to every child of the turn; painting those as failures
    // would report the user's own action as an error.
    expect(isTerminal("interrupted")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isRunning(subagent({ toolCallId: "a", status: "interrupted" }))).toBe(false);
  });

  it("tallies every status in one pass", () => {
    const list = [
      subagent({ toolCallId: "a", status: "running" }),
      subagent({ toolCallId: "b", status: "completed" }),
      subagent({ toolCallId: "c", status: "interrupted" }),
      subagent({ toolCallId: "d", status: "completed" }),
    ];
    expect(tallySubagents(list)).toEqual({
      total: 4,
      running: 1,
      completed: 2,
      failed: 0,
      interrupted: 1,
    });
    expect(tallySubagents([]).total).toBe(0);
  });
});

describe("elapsedMs", () => {
  it("runs to the caller's clock while live and to endedAtMs once settled", () => {
    const live = subagent({ toolCallId: "a", startedAtMs: 1000 });
    expect(elapsedMs(live, 4000)).toBe(3000);
    const done = subagent({ toolCallId: "a", startedAtMs: 1000, endedAtMs: 2500 });
    expect(elapsedMs(done, 9999)).toBe(1500);
  });

  it("never goes negative", () => {
    // The start is stamped by the Rust projector and `now` by the renderer; a
    // wall clock that steps back between them must not render "-3s".
    expect(elapsedMs(subagent({ toolCallId: "a", startedAtMs: 5000 }), 1000)).toBe(0);
  });
});

describe("attribution", () => {
  it("separates a mail child from one that has simply done nothing yet", () => {
    // The native engine's children run on their own threads, so their calls
    // never reach this session: 0 is "not visible", not "none".
    expect(hasAttributedWork(subagent({ toolCallId: "a", toolCallCount: 0 }))).toBe(false);
    expect(hasAttributedWork(subagent({ toolCallId: "a", toolCallCount: 3 }))).toBe(true);
  });

  it("picks a child's calls out of the parent's interleaved stream", () => {
    const messages = [
      message("m1", [
        call({ id: "own" }),
        call({ id: "c1", parentToolCallId: "task-a" }),
        call({ id: "c2", parentToolCallId: "task-b" }),
      ]),
      message("m2", [call({ id: "c3", parentToolCallId: "task-a" })]),
    ];
    expect(childCallsOf(messages, "task-a").map((c) => c.id)).toEqual(["c1", "c3"]);
    expect(childCallsOf(messages, "task-missing")).toEqual([]);

    const byParent = childCallsByParent(messages);
    expect([...byParent.keys()].sort()).toEqual(["task-a", "task-b"]);
    expect(byParent.get("task-a")?.map((c) => c.id)).toEqual(["c1", "c3"]);
    // The parent's own work is never bucketed under a child.
    expect([...byParent.values()].flat().some((c) => c.id === "own")).toBe(false);
  });
});

describe("placement", () => {
  it("names the launching calls, which a transcript renders as rows instead", () => {
    const ids = launchCallIds({
      "task-a": subagent({ toolCallId: "task-a" }),
      "task-b": subagent({ toolCallId: "task-b" }),
    });
    expect(ids.has("task-a")).toBe(true);
    expect(ids.has("c1")).toBe(false);
    expect(launchCallIds(undefined).size).toBe(0);
  });

  it("groups children by the message that launched them, in launch order", () => {
    const ordered = orderedSubagents({
      a: subagent({ toolCallId: "a", messageId: "m1", startedAtMs: 1 }),
      b: subagent({ toolCallId: "b", messageId: "m2", startedAtMs: 2 }),
      c: subagent({ toolCallId: "c", messageId: "m1", startedAtMs: 3 }),
    });
    expect(subagentsOfMessage(ordered, "m1").map((s) => s.toolCallId)).toEqual(["a", "c"]);
    expect(subagentsOfMessage(ordered, "m9")).toEqual([]);
  });
});

describe("displayName", () => {
  it("never renders an empty label", () => {
    // The detector falls back to a clipped prompt line, but an agent that sent
    // neither a name nor a prompt leaves nothing.
    expect(displayName(subagent({ toolCallId: "a", name: "counter" }))).toBe("counter");
    expect(displayName(subagent({ toolCallId: "a", name: "   " }))).toBe("Subagent");
  });
});
