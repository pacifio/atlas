// The Memory tabs' pure shaping: the Memories list's groups and summary, the
// Activity history's session groups, and the Review queue's order.
import { describe, expect, it } from "vitest";
import type { MemoryEntry, MemoryEvent, ReviewQueue } from "./shared-memory-api";
import {
  entryMatches,
  groupEntries,
  inScope,
  memorySummary,
  mostUsed,
  provenanceSession,
} from "./memory-entries";
import { activityTally, buildActivity, dayLabel } from "./memory-activity";
import { orderQueue, reviewCount, reviewItems } from "./memory-review-items";

function entry(id: number, over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    kind: "fact",
    key: "",
    content: `entry ${id}`,
    status: "",
    source: "extractor",
    agent: "codex",
    sessionId: "s1",
    confidence: 0.8,
    createdAt: 1,
    updatedAt: id,
    lastUsedAt: null,
    uses: 0,
    revision: 1,
    state: "active",
    ...over,
  } as MemoryEntry;
}

function event(seq: number, over: Partial<MemoryEvent> = {}): MemoryEvent {
  return {
    seq,
    ts: seq * 1000,
    agent: "claude-code",
    sessionId: "s1",
    kind: "fact",
    key: "",
    payload: { text: `event ${seq}` },
    ...over,
  } as MemoryEvent;
}

describe("the Memories list", () => {
  it("groups by kind in reading order, newest first inside a group", () => {
    const groups = groupEntries([
      entry(1, { kind: "fact" }),
      entry(2, { kind: "decision" }),
      entry(3, { kind: "fact" }),
      entry(4, { kind: "plan" }),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["plan", "decision", "fact"]);
    expect(groups[2].entries.map((e) => e.id)).toEqual([3, 1]);
  });

  it("calls failures dead ends", () => {
    expect(groupEntries([entry(1, { kind: "failure" })])[0].label).toBe("Dead ends");
  });

  it("splits current from archived", () => {
    expect(inScope(entry(1, { state: "candidate" }), "current")).toBe(true);
    expect(inScope(entry(1, { state: "archived" }), "current")).toBe(false);
    expect(inScope(entry(1, { state: "archived" }), "archived")).toBe(true);
  });

  it("matches the words, the key and the kind's name", () => {
    const e = entry(1, { kind: "failure", key: "retry-policy", content: "Never retry a 4xx" });
    expect(entryMatches(e, "4xx")).toBe(true);
    expect(entryMatches(e, "retry-policy")).toBe(true);
    expect(entryMatches(e, "dead end")).toBe(true);
    expect(entryMatches(e, "pagination")).toBe(false);
  });

  it("summarises only what agents can still read", () => {
    const s = memorySummary([
      entry(1, { agent: "codex" }),
      entry(2, { agent: "claude-code", state: "candidate" }),
      entry(3, { agent: "user" }),
      entry(4, { agent: "opencode", state: "archived" }),
    ]);
    expect(s).toMatchObject({ current: 3, unconfirmed: 1, archived: 1 });
    expect(s.agents).toEqual(["codex", "claude-code"]);
    expect(s.newest?.id).toBe(3);
  });

  it("leans on the most-used active entries", () => {
    const top = mostUsed([
      entry(1, { uses: 2 }),
      entry(2, { uses: 9 }),
      entry(3, { uses: 50, state: "archived" }),
      entry(4, { uses: 0 }),
    ]);
    expect(top.map((e) => e.id)).toEqual([2, 1]);
  });

  it("reads the session out of a provenance source", () => {
    const base = { agent: "x", added: "", title: null, commits: [] };
    expect(provenanceSession({ ...base, source: "atlas-session:claude-code/abc-1" })).toEqual({
      agent: "claude-code",
      sessionId: "abc-1",
    });
    expect(provenanceSession({ ...base, source: "import:claude" })).toBeNull();
  });
});

describe("the Activity history", () => {
  const now = new Date(2026, 8, 18, 12).getTime();

  it("groups consecutive events from one session, newest first, without the brackets", () => {
    const days = buildActivity(
      [
        event(1, { kind: "session_start" }),
        event(2),
        event(3, { kind: "decision", payload: { text: "Use RS256" } }),
        event(4, { sessionId: "s2", agent: "codex" }),
      ],
      [],
      now,
    );
    const groups = days.flatMap((d) => d.groups);
    expect(groups.map((g) => g.sessionId)).toEqual(["s2", "s1"]);
    expect(groups[1].lines.map((l) => l.seq)).toEqual([3, 2]);
  });

  it("links a line to the entry it became, by key or by words", () => {
    const days = buildActivity(
      [
        event(1, { kind: "decision", key: "alg", payload: { text: "old words" } }),
        event(2, { payload: { text: "Staging seeds 200 users" } }),
      ],
      [
        entry(7, { kind: "decision", key: "alg", content: "new words" }),
        entry(8, { content: "Staging seeds 200 users" }),
      ],
      now,
    );
    const lines = days[0].groups[0].lines;
    expect(lines.map((l) => l.entryId)).toEqual([8, 7]);
  });

  it("says what became of a plan, and links an old plan only to its own words", () => {
    const days = buildActivity(
      [
        event(1, { kind: "plan_set", key: "plan", payload: { text: "Old plan", status: "done" } }),
        event(2, { kind: "plan_set", key: "plan", payload: { text: "New plan" } }),
      ],
      [entry(9, { kind: "plan", key: "plan", content: "New plan" })],
      now,
    );
    const [fresh, old] = days[0].groups[0].lines;
    expect([fresh.verb, fresh.entryId]).toEqual(["set the plan", 9]);
    expect([old.verb, old.entryId]).toEqual(["finished the plan", null]);
  });

  it("filters by words and by agent", () => {
    const events = [
      event(1, { payload: { text: "pagination breaks" } }),
      event(2, { agent: "codex", sessionId: "s2", payload: { text: "tokens only" } }),
    ];
    const lines = (q: string, agent = "") =>
      buildActivity(events, [], now, { query: q, agent })
        .flatMap((d) => d.groups)
        .flatMap((g) => g.lines.map((l) => l.text));
    expect(lines("pagination")).toEqual(["pagination breaks"]);
    expect(lines("", "codex")).toEqual(["tokens only"]);
  });

  it("names the day relative to now", () => {
    expect(dayLabel(now - 60_000, now)).toBe("Today");
    expect(dayLabel(now - 86_400_000, now)).toBe("Yesterday");
  });

  it("tallies a folded group by kind", () => {
    const days = buildActivity(
      [event(1), event(2), event(3, { kind: "decision" }), event(4, { kind: "failure" })],
      [],
      now,
    );
    expect(activityTally(days[0].groups[0].lines)).toBe("1 dead end, 1 decision, 2 facts");
  });
});

describe("the Review queue", () => {
  const queue: ReviewQueue = {
    candidates: [entry(1, { state: "candidate" })],
    merges: [{ keep: entry(2), drop: [entry(3)] }],
    conflicts: [{ a: entry(4), b: entry(5) }],
    dreams: [{ id: 41, op: { op: "archive" }, why: "", entries: [entry(6)] }],
  } as unknown as ReviewQueue;

  it("meets contradictions first, then proposals, duplicates and unconfirmed lines", () => {
    expect(reviewItems(queue).map((i) => i.type)).toEqual([
      "conflict",
      "dream",
      "merge",
      "candidate",
    ]);
    expect(reviewCount(queue)).toBe(4);
  });

  it("moves what was put off to the back, in the order it was put off", () => {
    const items = reviewItems(queue);
    const keys = orderQueue(items, ["dream:41", "conflict:4:5", "gone:9"]).map((i) => i.key);
    expect(keys).toEqual(["merge:2", "candidate:1", "dream:41", "conflict:4:5"]);
  });
});
