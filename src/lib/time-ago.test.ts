import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timeAgo } from "./time-ago";

/**
 * `timeAgo` reads `Date.now()`, so every case pins the clock. NOW is mid-year
 * deliberately: a date near 1 Jan would make the "same calendar year" branch
 * flip depending on when the suite runs.
 */
const NOW = new Date("2026-06-15T12:00:00.000Z");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** An ISO timestamp `ms` before the pinned NOW. */
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("timeAgo", () => {
  describe("absent and malformed input", () => {
    // Callers pass straight from optional API fields, so these arrive often.
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
    ])("returns an empty string for %s", (_label, input) => {
      expect(timeAgo(input)).toBe("");
    });

    it.each([
      ["not a date at all", "banana"],
      ["a bare time with no date", "12:00:00"],
      ["an impossible month", "2026-13-01T00:00:00Z"],
      ["an impossible hour", "2026-06-15T25:00:00Z"],
    ])("returns an empty string for %s", (_label, input) => {
      expect(timeAgo(input)).toBe("");
    });

    it("does not validate — partial dates are accepted, not rejected", () => {
      // `new Date("2026-06-")` is *not* NaN: it resolves to 1 June at local
      // midnight. Guarding the boundary is the caller's job, not `timeAgo`'s.
      // Only "was it accepted" is asserted — the rendered value depends on the
      // runner's timezone, which differs between a contributor's machine and
      // CI's UTC.
      expect(timeAgo("2026-06-")).not.toBe("");
    });
  });

  describe("unit boundaries", () => {
    // Each pair straddles a `<` in the implementation, where an off-by-one
    // shows up as "60m" instead of "1h".
    it.each([
      [0, "just now"],
      [59 * SECOND, "just now"],
      [MINUTE, "1m"],
      [59 * MINUTE, "59m"],
      [HOUR, "1h"],
      [23 * HOUR, "23h"],
      [DAY, "1d"],
      [6 * DAY, "6d"],
    ])("renders %ims as %s", (elapsed, expected) => {
      expect(timeAgo(ago(elapsed))).toBe(expected);
    });
  });

  describe("the seconds bucket", () => {
    it("is off by default, so sub-minute reads as 'just now'", () => {
      expect(timeAgo(ago(30 * SECOND))).toBe("just now");
    });

    it.each([
      [0, "just now"],
      [4 * SECOND, "just now"],
      [5 * SECOND, "5s"],
      [59 * SECOND, "59s"],
      [MINUTE, "1m"],
    ])("with seconds enabled renders %ims as %s", (elapsed, expected) => {
      expect(timeAgo(ago(elapsed), { seconds: true })).toBe(expected);
    });
  });

  describe("the suffix option", () => {
    it.each([
      [5 * SECOND, "5s ago"],
      [MINUTE, "1m ago"],
      [HOUR, "1h ago"],
      [DAY, "1d ago"],
    ])("appends ' ago' to %ims", (elapsed, expected) => {
      expect(timeAgo(ago(elapsed), { suffix: true, seconds: true })).toBe(expected);
    });

    it("leaves 'just now' alone, which has no unit to qualify", () => {
      expect(timeAgo(ago(0), { suffix: true })).toBe("just now");
    });
  });

  describe("past a week", () => {
    // Asserted by shape rather than by re-running `toLocaleDateString`, which
    // would just restate the implementation and pass regardless of behaviour.
    // The runner's locale is not fixed, so only locale-invariant facts are
    // checked: day-of-month always appears, the year only outside this year.
    it("switches from a day count to a date", () => {
      const out = timeAgo(ago(7 * DAY));
      expect(out).not.toMatch(/^\d+d$/);
      expect(out).toContain("8");
    });

    it("omits the year within the current year", () => {
      expect(timeAgo(ago(30 * DAY))).not.toContain("2026");
    });

    it("includes the year for an earlier year", () => {
      expect(timeAgo("2023-03-20T12:00:00.000Z")).toContain("2023");
    });

    it("keeps counting days when noDateFallback is set", () => {
      expect(timeAgo(ago(30 * DAY), { noDateFallback: true })).toBe("30d");
      expect(timeAgo(ago(400 * DAY), { noDateFallback: true })).toBe("400d");
    });
  });

  describe("timestamps in the future", () => {
    // Clock skew between the Rust backend and the WebView produces these; the
    // sidebar must not render "-1m" or a date from next week.
    it.each([
      ["a minute ahead", MINUTE],
      ["a day ahead", DAY],
    ])("clamps %s to 'just now'", (_label, ahead) => {
      expect(timeAgo(ago(-ahead))).toBe("just now");
    });

    it("clamps to 'just now' with the seconds bucket enabled too", () => {
      expect(timeAgo(ago(-HOUR), { seconds: true })).toBe("just now");
    });
  });

  it("accepts a non-UTC offset for the same instant", () => {
    // The backend emits offsets, not always Z.
    expect(timeAgo("2026-06-15T09:00:00.000-03:00")).toBe("just now");
  });
});
