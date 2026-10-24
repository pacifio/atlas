import { describe, expect, it } from "vitest";
import { blameParts, relativeTime } from "./blame";

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const ago = (seconds: number) => relativeTime(NOW - seconds * 1000, NOW);
const MIN = 60;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Expected strings are what `git log --format=%cr` prints for the same gap. */
describe("relativeTime matches git's %cr", () => {
  it("rounds hours to nearest, as History does", () => {
    // 22h40m: the floor version said "22 hours ago" beside History's "23".
    expect(ago(22 * HOUR + 40 * MIN)).toBe("23 hours ago");
    expect(ago(22 * HOUR + 20 * MIN)).toBe("22 hours ago");
  });

  it("keeps git's thresholds between units", () => {
    expect(ago(45)).toBe("45 seconds ago");
    expect(ago(89)).toBe("89 seconds ago");
    expect(ago(80 * MIN)).toBe("80 minutes ago");
    expect(ago(30 * HOUR)).toBe("30 hours ago");
    expect(ago(36 * HOUR)).toBe("2 days ago");
    expect(ago(1 * DAY + 13 * HOUR)).toBe("2 days ago");
    expect(ago(20 * DAY)).toBe("3 weeks ago");
    expect(ago(100 * DAY)).toBe("3 months ago");
  });

  it("says years and months, then whole years", () => {
    expect(ago(400 * DAY)).toBe("1 year, 1 month ago");
    expect(ago(730 * DAY)).toBe("2 years ago");
    expect(ago(2000 * DAY)).toBe("5 years ago");
  });

  it("is empty for a line with no commit time", () => {
    expect(relativeTime(0, NOW)).toBe("");
  });
});

describe("blameParts", () => {
  it("reads author, time and summary for a committed line", () => {
    const parts = blameParts({
      line: 1,
      sha: "abc",
      shortSha: "abc",
      author: "Ada",
      timeMs: 0,
      summary: "first",
      committed: true,
    });
    expect(parts).toEqual([
      { kind: "author", text: "Ada" },
      { kind: "sep", text: " · " },
      { kind: "summary", text: "first" },
    ]);
  });

  it("says uncommitted for a line git has no commit for", () => {
    expect(
      blameParts(undefined)
        .map((p) => p.text)
        .join(""),
    ).toBe("You · Uncommitted changes");
  });
});
