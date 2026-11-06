import { afterEach, describe, expect, it } from "vitest";
import {
  formatDateTime,
  formatDayAwareTime,
  formatFullTimestamp,
  formatTime,
  formatWith,
  hourCycle,
  setTimeFormat,
} from "./format-time";

const AFTERNOON = new Date(2026, 9, 22, 15, 7);

afterEach(() => setTimeFormat("system"));

describe("format-time", () => {
  it("leaves the clock to the locale under system", () => {
    expect(hourCycle()).toEqual({});
    expect(formatTime(AFTERNOON, undefined, "en-US")).toBe("3:07 PM");
  });

  it("forces a 24-hour clock", () => {
    setTimeFormat("24h");
    expect(formatTime(AFTERNOON, undefined, "en-US")).toBe("15:07");
    expect(formatDateTime(AFTERNOON, { hour: "numeric", minute: "2-digit" }, "en-US")).toBe(
      "15:07",
    );
  });

  it("writes midnight as 00, not 24, on a 24-hour clock in a 12-hour locale", () => {
    setTimeFormat("24h");
    expect(formatTime(new Date(2026, 0, 1, 0, 5), undefined, "en-US")).toBe("00:05");
  });

  it("forces a 12-hour clock", () => {
    setTimeFormat("12h");
    expect(formatTime(AFTERNOON, undefined, "en-GB")).toMatch(/^3:07\s?pm$/i);
  });
});

// The cached formatters stand in for `toLocale*String` calls, which fill in
// fields the caller left out. These pin that the stand-ins print the same.
describe("formatWith", () => {
  const cases: [Intl.DateTimeFormatOptions, "time" | "date" | "any"][] = [
    [{}, "time"],
    [{ hour: "2-digit", minute: "2-digit", second: "2-digit" }, "time"],
    [{ month: "short" }, "time"],
    [{}, "date"],
    [{ weekday: "long" }, "date"],
    [{ month: "long", day: "numeric" }, "date"],
    [{}, "any"],
    [{ hour: "numeric" }, "any"],
    [{ timeStyle: "short" }, "any"],
  ];

  it.each(cases)("prints what toLocale*String prints for %j as %s", (options, kind) => {
    const expected =
      kind === "time"
        ? AFTERNOON.toLocaleTimeString("en-US", options)
        : kind === "date"
          ? AFTERNOON.toLocaleDateString("en-US", options)
          : AFTERNOON.toLocaleString("en-US", options);
    expect(formatWith(AFTERNOON, options, kind, "en-US")).toBe(expected);
    // Twice: the second call is served by the cached formatter.
    expect(formatWith(AFTERNOON, options, kind, "en-US")).toBe(expected);
  });

  it("prints Invalid Date for an unparseable timestamp, as toLocale*String does", () => {
    expect(formatWith("not a date", {}, "time", "en-US")).toBe("Invalid Date");
    expect(formatTime("not a date", undefined, "en-US")).toBe("Invalid Date");
  });

  it("does not reuse a formatter across hour cycles", () => {
    expect(formatTime(AFTERNOON, undefined, "en-US")).toBe("3:07 PM");
    setTimeFormat("24h");
    expect(formatTime(AFTERNOON, undefined, "en-US")).toBe("15:07");
  });
});

describe("formatDayAwareTime", () => {
  const NOW = new Date(2026, 9, 24, 9, 30);
  const fmt = (at: Date) => formatDayAwareTime(at, NOW, "en-US");

  it("shows the time alone for a message from today", () => {
    expect(fmt(new Date(2026, 9, 24, 0, 1))).toBe("12:01 AM");
    expect(fmt(new Date(2026, 9, 24, 9, 29))).toBe("9:29 AM");
  });

  it("treats a later time on the same day as today", () => {
    expect(fmt(new Date(2026, 9, 24, 9, 31))).toBe("9:31 AM");
  });

  it("dates a timestamp from a future day rather than passing it off as today", () => {
    expect(fmt(new Date(2026, 9, 25, 0, 5))).toBe("10/25 12:05 AM");
    expect(fmt(new Date(2027, 0, 2, 8, 0))).toBe("1/2/2027 8:00 AM");
  });

  it("picks up a changed hour cycle instead of reusing a cached formatter", () => {
    const at = new Date(2026, 9, 24, 16, 34);
    expect(fmt(at)).toBe("4:34 PM");
    setTimeFormat("24h");
    expect(fmt(at)).toBe("16:34");
    setTimeFormat("system");
    expect(fmt(at)).toBe("4:34 PM");
  });

  it("says yesterday for the previous calendar day, however few hours ago", () => {
    expect(fmt(new Date(2026, 9, 23, 23, 59))).toBe("yesterday at 11:59 PM");
    expect(fmt(new Date(2026, 9, 23, 0, 0))).toBe("yesterday at 12:00 AM");
  });

  it("adds month and day for an earlier day this year", () => {
    expect(fmt(new Date(2026, 9, 22, 16, 34))).toBe("10/22 4:34 PM");
    expect(fmt(new Date(2026, 0, 1, 8, 0))).toBe("1/1 8:00 AM");
  });

  it("adds the year for a message from another year", () => {
    expect(fmt(new Date(2025, 9, 22, 16, 34))).toBe("10/22/2025 4:34 PM");
  });

  it("follows the 24-hour setting", () => {
    setTimeFormat("24h");
    expect(fmt(new Date(2026, 9, 22, 16, 34))).toBe("10/22 16:34");
  });

  it("renders nothing for an unparseable timestamp", () => {
    expect(formatDayAwareTime("not a date", NOW, "en-US")).toBe("");
  });
});

describe("formatFullTimestamp", () => {
  it("spells out the weekday, date and time", () => {
    expect(formatFullTimestamp(new Date(2026, 9, 22, 16, 34), "en-US")).toBe(
      "Thursday, October 22, 2026 at 4:34 PM",
    );
  });

  it("renders nothing for an unparseable timestamp", () => {
    expect(formatFullTimestamp("", "en-US")).toBe("");
  });
});
