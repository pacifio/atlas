import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types/agent";
import { projectRows, type ProjectOptions } from "./turn-rows";
import {
  deriveTurnRailItems,
  resolveTurnRailCurrentIndex,
  resolveTurnRailHasPersistentGutter,
  resolveTurnRailHeightStyle,
  resolveTurnRailHitStripWidth,
  resolveTurnRailIndexFromPointer,
  resolveTurnRailInteractiveWidth,
  resolveTurnRailNavigationInteractive,
  resolveTurnRailPreview,
  resolveTurnRailTopPercent,
  stableTurnRailItems,
  turnRailPreviewSource,
} from "./turn-rail";

// The turn rail's pure half: one tick per user turn, the preview each tick's
// card shows, where the ticks sit, and which turn counts as current.

const OPTS: ProjectOptions = {
  expanded: new Set<string>(),
  streaming: false,
  expandedTurns: new Set<string>(),
};

function message(id: string, role: "user" | "assistant", content: string) {
  return {
    id,
    role,
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-10-24T09:00:00Z",
    ...(role === "assistant" ? { mode: "text" } : {}),
  } as ChatMessage;
}

const THREAD = [
  message("u1", "user", "First question"),
  message("a1", "assistant", "First answer"),
  message("u2", "user", "Second\n\n  question"),
  message("a2", "assistant", "Working on it"),
  message("a3", "assistant", "**Done**: see [the PR](https://example.com)."),
  message("u3", "user", "Third, unanswered"),
];

describe("deriveTurnRailItems", () => {
  it("makes one item per user turn, addressed by its row id and message index", () => {
    const items = deriveTurnRailItems(projectRows(THREAD, OPTS));
    expect(items).toEqual([
      { id: "u:u1", messageIndex: 0 },
      { id: "u:u2", messageIndex: 2 },
      { id: "u:u3", messageIndex: 5 },
    ]);
  });

  it("is empty for a session with no prompts", () => {
    expect(deriveTurnRailItems(projectRows([message("a", "assistant", "hi")], OPTS))).toEqual([]);
  });
});

describe("stableTurnRailItems", () => {
  it("keeps the previous array while the turns are the same", () => {
    const prev = deriveTurnRailItems(projectRows(THREAD, OPTS));
    const streamed = [...THREAD, message("a4", "assistant", "Streaming a reply")];
    const next = deriveTurnRailItems(projectRows(streamed, OPTS));
    expect(stableTurnRailItems(prev, next)).toBe(prev);
  });

  it("takes the new array when a turn is added or moves", () => {
    const prev = deriveTurnRailItems(projectRows(THREAD, OPTS));
    const longer = deriveTurnRailItems(projectRows([...THREAD, message("u4", "user", "x")], OPTS));
    expect(stableTurnRailItems(prev, longer)).toBe(longer);
    const moved = longer
      .slice(0, 3)
      .map((item) => ({ ...item, messageIndex: item.messageIndex + 1 }));
    expect(stableTurnRailItems(prev, moved)).toBe(moved);
    expect(stableTurnRailItems(null, prev)).toBe(prev);
  });
});

describe("previews", () => {
  const rows = projectRows(THREAD, OPTS).rows;

  it("pairs a prompt with the agent's final text before the next prompt", () => {
    expect(turnRailPreviewSource(rows, "u:u2")).toEqual({
      userText: "Second\n\n  question",
      assistantText: "**Done**: see [the PR](https://example.com).",
    });
    expect(turnRailPreviewSource(rows, "u:u3")).toEqual({
      userText: "Third, unanswered",
      assistantText: null,
    });
    expect(turnRailPreviewSource(rows, "u:missing")).toBeNull();
  });

  it("collapses whitespace and reduces the reply's markdown to its words", () => {
    expect(resolveTurnRailPreview(turnRailPreviewSource(rows, "u:u2"))).toEqual({
      userText: "Second question",
      assistantText: "Done: see the PR.",
    });
    expect(
      resolveTurnRailPreview({ userText: "  ", assistantText: "<div>a</div><b>b</b>\n\n- c\n- d" }),
    ).toEqual({ userText: null, assistantText: "a b c d" });
    expect(resolveTurnRailPreview(null)).toBeNull();
  });
});

describe("geometry", () => {
  it("spaces ticks 8px apart until the rail reaches its cap, then compresses", () => {
    expect(resolveTurnRailHeightStyle(1)).toBe("min(1px, calc(100vh - 18rem))");
    expect(resolveTurnRailHeightStyle(11)).toBe("min(80px, calc(100vh - 18rem))");
    expect(resolveTurnRailHeightStyle(501)).toBe("min(4000px, calc(100vh - 18rem))");
  });

  it("places ticks by percentage, clamped", () => {
    expect(resolveTurnRailTopPercent(0, 1)).toBe(0);
    expect(resolveTurnRailTopPercent(0, 5)).toBe(0);
    expect(resolveTurnRailTopPercent(2, 5)).toBe(50);
    expect(resolveTurnRailTopPercent(9, 5)).toBe(100);
    expect(resolveTurnRailTopPercent(-1, 5)).toBe(0);
  });

  it("maps the pointer to the nearest tick", () => {
    const at = (pointerY: number, itemCount = 5) =>
      resolveTurnRailIndexFromPointer({ itemCount, railTop: 100, railHeight: 40, pointerY });
    expect(at(100)).toBe(0);
    expect(at(114)).toBe(1);
    expect(at(120)).toBe(2);
    expect(at(140)).toBe(4);
    expect(at(0)).toBe(0);
    expect(at(999)).toBe(4);
    expect(at(120, 1)).toBe(0);
    expect(at(120, 0)).toBeNull();
    expect(
      resolveTurnRailIndexFromPointer({ itemCount: 3, railTop: 0, railHeight: 0, pointerY: 0 }),
    ).toBeNull();
  });

  it("shows the rail at rest from a 48px gutter, on hover below it, never under 13px", () => {
    expect(resolveTurnRailHasPersistentGutter(48)).toBe(true);
    expect(resolveTurnRailHasPersistentGutter(47)).toBe(false);
    expect(resolveTurnRailHasPersistentGutter(Number.NaN)).toBe(false);
    expect(resolveTurnRailHitStripWidth(0)).toBe(0);
    expect(resolveTurnRailHitStripWidth(12)).toBe(0);
    expect(resolveTurnRailHitStripWidth(30.7)).toBe(18);
    expect(resolveTurnRailHitStripWidth(400)).toBe(40);
    expect(resolveTurnRailHitStripWidth(-5)).toBe(0);
  });

  it("offers previous/next only when the strip can hold them, and widens for the card", () => {
    expect(resolveTurnRailNavigationInteractive(13)).toBe(false);
    expect(resolveTurnRailNavigationInteractive(14)).toBe(true);
    expect(resolveTurnRailInteractiveWidth(30, false)).toBe(30);
    expect(resolveTurnRailInteractiveWidth(30, true)).toBe("22rem");
  });
});

describe("resolveTurnRailCurrentIndex", () => {
  it("prefers the first prompt in view", () => {
    expect(resolveTurnRailCurrentIndex(["above", "in", "in", "below"])).toBe(1);
  });

  it("falls back to the turn being read when no prompt is in view", () => {
    expect(resolveTurnRailCurrentIndex(["above", "above", "below"])).toBe(1);
    expect(resolveTurnRailCurrentIndex(["above", "above"])).toBe(1);
  });

  it("is null before the first prompt", () => {
    expect(resolveTurnRailCurrentIndex(["below", "below"])).toBeNull();
    expect(resolveTurnRailCurrentIndex([])).toBeNull();
  });
});
