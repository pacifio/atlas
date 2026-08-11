/**
 * The board's derivations — the numbers the Timeline's tiles and day headers
 * are made of.
 *
 * Both bugs these cover shipped: an unbounded duration string painted across
 * the tile beside it (`42488h 06m`), and grouping on `updatedAt` filed a year
 * of imported history under Today because an import rewrites every row.
 */

import { describe, expect, it } from "vitest";

import { bucketByDay, formatDuration, startOfDay, tokenLabel } from "./board";
import type { BoardSession } from "../types";

function session(overrides: Partial<BoardSession> = {}): BoardSession {
  return {
    id: "as-1",
    title: "Work",
    agent: "claude-code",
    model: null,
    source: "external_jsonl",
    startedAt: "2026-06-01T16:10:00.000Z",
    updatedAt: "2026-07-29T19:13:00.000Z",
    lastActivityAt: "2026-06-01T16:12:00.000Z",
    activeSeconds: 120,
    wallSeconds: 120,
    messageCount: 4,
    toolCallCount: 0,
    checkpointCount: 0,
    branches: [],
    insertions: 0,
    deletions: 0,
    filesTouched: 0,
    totalTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: null,
    contextSize: null,
    needsAttention: false,
    attentionReason: null,
    projectPath: "/tmp/atlas",
    projectName: "atlas",
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("reads as minutes below an hour", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(59)).toBe("1m");
    expect(formatDuration(47 * 60)).toBe("47m");
  });

  it("zero-pads minutes so the column stays aligned", () => {
    expect(formatDuration(64 * 60)).toBe("1h 04m");
    expect(formatDuration(99 * 3600 + 59 * 60)).toBe("99h 59m");
  });

  it("drops minutes, then hours, rather than overflowing its tile", () => {
    // Nobody reads the `06m` in `42488h 06m`, and the tile is 150px wide.
    expect(formatDuration(142 * 3600)).toBe("142h");
    expect(formatDuration(42_488 * 3600 + 6 * 60)).toBe("1,770d");
  });

  it("never renders wider than a stat tile can hold", () => {
    for (const seconds of [0, 59, 90 * 60, 99 * 3600, 100 * 3600, 42_488 * 3600, 1e9]) {
      expect(formatDuration(seconds).length).toBeLessThanOrEqual(8);
    }
  });
});

describe("bucketByDay", () => {
  it("groups on when the work happened, not when the row was written", () => {
    // What a bulk import looks like: every row rewritten today, all of the
    // work months old and spread across three days.
    const rows = [
      session({ id: "a", lastActivityAt: "2026-06-01T16:12:00.000Z" }),
      session({ id: "b", lastActivityAt: "2026-06-15T09:00:00.000Z" }),
      session({ id: "c", lastActivityAt: "2026-06-15T18:00:00.000Z" }),
    ];
    const days = bucketByDay(rows);

    // Expectations derived rather than hardcoded, so the test says the same
    // thing in every timezone the app runs in.
    const expected = new Set(rows.map((r) => startOfDay(new Date(r.lastActivityAt))));
    expect(new Set(days.keys())).toEqual(expected);
    // The rows were all written in the same moment, so grouping on `updatedAt`
    // would have produced exactly one bucket — the 106-sessions-under-Today bug.
    expect(new Set(rows.map((r) => startOfDay(new Date(r.updatedAt)))).size).toBe(1);
    expect(days.size).toBeGreaterThan(1);
    for (const [key, bucket] of days) {
      for (const row of bucket) expect(startOfDay(new Date(row.lastActivityAt))).toBe(key);
    }
  });

  it("buckets on local midnight, not UTC", () => {
    // 01:00 UTC is the previous evening anywhere west of Greenwich, and the
    // day header has to say the day the developer was working.
    const late = session({ id: "late", lastActivityAt: "2026-06-02T01:00:00.000Z" });
    const key = [...bucketByDay([late]).keys()][0];
    expect(key).toBe(startOfDay(new Date("2026-06-02T01:00:00.000Z")));
    expect(new Date(key).getHours()).toBe(0);
  });
});

describe("tokenLabel", () => {
  it("prefers a real split, then the gauge, then cache", () => {
    expect(tokenLabel(session({ totalTokens: 212_800 }))).toBe("212.8K tok");
    expect(tokenLabel(session({ contextUsed: 853_100, contextSize: 1_000_000 }))).toBe(
      "853.1K / 1.00M ctx",
    );
    expect(tokenLabel(session({ cacheReadTokens: 15_565 }))).toBe("15.6K cached");
  });

  it("says nothing when there is genuinely nothing to say", () => {
    expect(tokenLabel(session())).toBeNull();
  });

  it("reaches billions, because cache reads do", () => {
    expect(tokenLabel(session({ cacheReadTokens: 1_548_473_497 }))).toBe("1.55B cached");
  });
});
