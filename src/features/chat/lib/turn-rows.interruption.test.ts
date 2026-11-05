import { describe, expect, it } from "vitest";
import { projectRows, RowKind, type InterruptionRow } from "./turn-rows";
import { formatSlept, interruptionHeadline } from "./interruption-copy";
import type { ChatMessage, TurnInterruption } from "@/types/agent";

const OPTS = { expanded: new Set<string>(), streaming: false, expandedTurns: new Set<string>() };

function msg(id: string, role: "user" | "assistant", content: string): ChatMessage {
  return {
    id,
    role,
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-23T00:00:00Z",
    mode: role === "assistant" ? "text" : undefined,
  } as ChatMessage;
}

const SLEPT: TurnInterruption = { cause: "sleep", sleptSecs: 1260, outcome: "finished" };

function interruptionRows(messages: ChatMessage[]): InterruptionRow[] {
  return projectRows(messages, OPTS).rows.filter(
    (r): r is InterruptionRow => r.kind === RowKind.Interruption,
  );
}

describe("an interrupted turn", () => {
  it("closes its turn with an interruption row, after the reply", () => {
    const reply = { ...msg("a1", "assistant", "half a reply"), interruption: SLEPT };
    const { rows } = projectRows([msg("u1", "user", "go"), reply], OPTS);
    expect(rows[rows.length - 1]).toMatchObject({
      kind: RowKind.Interruption,
      id: "x:a1",
      latest: true,
    });
    // The reply itself is untouched prose — the record is not text in it.
    expect(rows.some((r) => r.kind === RowKind.Prose && r.text === "half a reply")).toBe(true);
  });

  it("is latest only on the thread's last turn", () => {
    const rows = interruptionRows([
      msg("u1", "user", "first"),
      { ...msg("a1", "assistant", "cut"), interruption: SLEPT },
      msg("u2", "user", "second"),
      msg("a2", "assistant", "fine"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].latest).toBe(false);
  });

  it("a turn cut off before any output is the row alone, with no empty prose", () => {
    const host = {
      ...msg("a1", "assistant", ""),
      interruption: { ...SLEPT, outcome: "failed", error: "connection reset" } as TurnInterruption,
    };
    const projection = projectRows([msg("u1", "user", "go"), host], OPTS);
    const assistantRows = projection.rows.filter((r) => r.turnId !== projection.turns[0].id);
    expect(assistantRows.map((r) => r.kind)).toEqual([RowKind.Interruption]);
    // A failure marks the turn as errored in the nav rail.
    expect(projection.turns[projection.turns.length - 1].status).toBe("error");
  });
});

describe("interruption wording", () => {
  it("tells a sleep in the unit a person would use", () => {
    expect(formatSlept(45)).toBe("45s");
    expect(formatSlept(1260)).toBe("21m");
    expect(formatSlept(3600)).toBe("1h");
    expect(formatSlept(3780)).toBe("1h 3m");
  });

  it("says what happened to the reply, per outcome", () => {
    expect(interruptionHeadline(SLEPT)).toBe(
      "Your computer slept for 21m during this reply — it may be incomplete.",
    );
    expect(interruptionHeadline({ ...SLEPT, outcome: "failed", error: "x" })).toBe(
      "Your computer slept for 21m and the reply was cut off.",
    );
    // The agent's error is a detail, never the headline.
    expect(interruptionHeadline({ ...SLEPT, outcome: "failed", error: "boom" })).not.toContain(
      "boom",
    );
  });
});
