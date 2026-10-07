/**
 * The board's derivations — the numbers the Timeline's tiles and day headers
 * are made of.
 *
 * Both bugs these cover shipped: an unbounded duration string painted across
 * the tile beside it (`42488h 06m`), and grouping on `updatedAt` filed a year
 * of imported history under Today because an import rewrites every row.
 */

import { describe, expect, it } from "vitest";

import {
  bucketByDay,
  formatDuration,
  groupSessions,
  prettyModel,
  sessionTitle,
  startOfDay,
  startOfMonth,
  startOfWeek,
  tokenLabel,
} from "./board";
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
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: null,
    contextSize: null,
    needsAttention: false,
    attentionReason: null,
    projectPath: "/tmp/atlas",
    projectName: "atlas",
    synced: false,
    origin: "local",
    remoteProjectId: null,
    authorId: null,
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
    // `toLocaleString` groups the days in the machine's locale (1,770 / 1.770).
    expect(formatDuration(42_488 * 3600 + 6 * 60)).toBe(`${(1770).toLocaleString()}d`);
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

describe("prettyModel", () => {
  it("reads a hyphenated minor version", () => {
    // The cost card said "Sonnet 4" for a Sonnet 4.6 Session.
    expect(prettyModel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(prettyModel("claude-opus-4-5")).toBe("Opus 4.5");
  });

  it("never reads a date suffix as a version", () => {
    expect(prettyModel("claude-opus-4-20250514")).toBe("Opus 4");
    expect(prettyModel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(prettyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });

  it("keeps dotted, bare and bracketed ids working", () => {
    expect(prettyModel("claude-opus-5.5")).toBe("Opus 5.5");
    expect(prettyModel("claude-fable-5[1m]")).toBe("Fable 5");
    expect(prettyModel("claude-3-5-sonnet-20240620")).toBe("Sonnet 3.5");
    expect(prettyModel("gpt-5.5-codex")).toBe("GPT-5.5 Codex");
    expect(prettyModel(null)).toBeNull();
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

describe("grouping grain", () => {
  it("starts a week on Monday and a month on the 1st", () => {
    // A Sunday — the day the Sunday-first convention gets wrong.
    const sunday = new Date(2026, 6, 12, 15, 0);
    expect(new Date(startOfWeek(sunday)).getDate()).toBe(6); // Monday 6 Jul
    expect(new Date(startOfWeek(sunday)).getDay()).toBe(1);
    expect(new Date(startOfMonth(sunday)).getDate()).toBe(1);
  });

  it("folds a week of days into one bucket", () => {
    const day = 86_400_000;
    const monday = new Date(startOfWeek(new Date()) + 9 * 3_600_000);
    const rows = [0, 1, 2].map((i) =>
      session({
        id: `s${i}`,
        lastActivityAt: new Date(monday.getTime() + i * day).toISOString(),
      }),
    );
    expect(groupSessions(rows, "day")).toHaveLength(3);
    const [week] = groupSessions(rows, "week");
    expect(week.sessions).toHaveLength(3);
    expect(week.label).toBe("This week");
  });
});

describe("sessionTitle", () => {
  // Titles stored before capture learned to derive past agent markup are the
  // prompt's first line verbatim — these are the shapes that reached the board.
  it("reads a stored paste opener as Pasted text", () => {
    expect(sessionTitle('<pasted_content id="8a17">')).toBe("Pasted text");
    expect(sessionTitle('</pasted_content id="8a17">')).toBe("Pasted text");
  });

  it("is null for a title that is any other lone wrapper tag", () => {
    expect(sessionTitle("<system-reminder>")).toBeNull();
    expect(sessionTitle('<some-new-wrapper kind="x">')).toBeNull();
  });

  it("keeps the words around inline markup", () => {
    expect(
      sessionTitle('fix <pasted_content id="01">TypeError</pasted_content id="01"> please'),
    ).toBe("fix TypeError please");
    expect(sessionTitle("[Image #1] why is this button misaligned")).toBe(
      "why is this button misaligned",
    );
    expect(
      sessionTitle("<command-name>/review</command-name> <command-args>auth</command-args>"),
    ).toBe("/review auth");
    expect(sessionTitle("<system-reminder>opened foo.ts</system-reminder> explain this")).toBe(
      "explain this",
    );
  });

  it("labels a title that was only an attachment placeholder", () => {
    expect(sessionTitle("[Pasted text #1 +42 lines]")).toBe("Pasted text");
    expect(sessionTitle("[Image #1] [Image #2]")).toBe("Image");
  });

  it("leaves ordinary titles, angle brackets included, alone", () => {
    expect(sessionTitle("Fix the drain")).toBe("Fix the drain");
    expect(sessionTitle("convert Vec<String> to a slice")).toBe("convert Vec<String> to a slice");
    expect(sessionTitle("why is a < b but <div> renders")).toBe("why is a < b but <div> renders");
    expect(sessionTitle(null)).toBeNull();
  });
});
