import { describe, expect, it } from "vitest";
import { customSnoozeUntil, snoozePresets, snoozeRemainingLabel } from "./session-snooze";

/** A local wall-clock time, so the tests read in the calendar they test. */
const local = (y: number, m: number, d: number, h: number, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0);

const ids = (now: Date) => snoozePresets(now).map((p) => p.id);
const untilOf = (now: Date, id: string) =>
  new Date(snoozePresets(now).find((p) => p.id === id)!.until);

describe("snoozePresets", () => {
  // 2026-10-21 is a Wednesday.
  it("offers every preset on a weekday morning", () => {
    const now = local(2026, 10, 21, 10);
    expect(ids(now)).toEqual(["hour", "three-hours", "evening", "tomorrow", "next-week"]);
    expect(untilOf(now, "hour").getTime()).toBe(now.getTime() + 3_600_000);
    expect(untilOf(now, "three-hours").getTime()).toBe(now.getTime() + 3 * 3_600_000);
    expect(untilOf(now, "evening")).toEqual(local(2026, 10, 21, 18));
    expect(untilOf(now, "tomorrow")).toEqual(local(2026, 10, 22, 9));
    expect(untilOf(now, "next-week")).toEqual(local(2026, 10, 26, 9));
  });

  it("drops This evening when 18:00 is an hour or less away", () => {
    expect(ids(local(2026, 10, 21, 17, 0))).not.toContain("evening");
    expect(ids(local(2026, 10, 21, 16, 59))).toContain("evening");
    expect(ids(local(2026, 10, 21, 20))).not.toContain("evening");
  });

  it("goes to the following Monday from a Monday, and skips it on a Sunday", () => {
    expect(untilOf(local(2026, 10, 26, 10), "next-week")).toEqual(local(2026, 11, 2, 9));
    // Sunday: next Monday 9:00 is tomorrow 9:00 — offered once, as Tomorrow.
    expect(ids(local(2026, 10, 25, 10))).not.toContain("next-week");
  });
});

describe("customSnoozeUntil", () => {
  const now = local(2026, 10, 21, 10);

  it("takes a local date and time in the future", () => {
    expect(customSnoozeUntil({ mode: "date", date: "2026-10-23", time: "14:30" }, now)).toBe(
      local(2026, 10, 23, 14, 30).toISOString(),
    );
  });

  it("refuses the past, malformed input and impossible dates", () => {
    expect(customSnoozeUntil({ mode: "date", date: "2026-10-20", time: "09:00" }, now)).toBeNull();
    expect(customSnoozeUntil({ mode: "date", date: "2026-02-30", time: "09:00" }, now)).toBeNull();
    expect(customSnoozeUntil({ mode: "date", date: "26-10-23", time: "9:00" }, now)).toBeNull();
  });

  it("takes a positive duration", () => {
    expect(customSnoozeUntil({ mode: "duration", amount: "90", unit: "minutes" }, now)).toBe(
      new Date(now.getTime() + 90 * 60_000).toISOString(),
    );
    expect(customSnoozeUntil({ mode: "duration", amount: "0", unit: "hours" }, now)).toBeNull();
    expect(customSnoozeUntil({ mode: "duration", amount: "x", unit: "days" }, now)).toBeNull();
  });
});

describe("snoozeRemainingLabel", () => {
  const now = local(2026, 10, 21, 10);
  const plus = (ms: number) => new Date(now.getTime() + ms).toISOString();
  it("is compact", () => {
    expect(snoozeRemainingLabel(plus(-1), now)).toBe("now");
    expect(snoozeRemainingLabel(plus(30_000), now)).toBe("1m");
    expect(snoozeRemainingLabel(plus(45 * 60_000), now)).toBe("45m");
    expect(snoozeRemainingLabel(plus(3 * 3_600_000), now)).toBe("3h");
    expect(snoozeRemainingLabel(plus(50 * 3_600_000), now)).toBe("3d");
  });
});
