import { describe, expect, it } from "vitest";
import type { AppNotification } from "../stores/notifications-store";
import { dayBucket, groupNotificationsByDay } from "./notification-groups";

// Local time, so the day boundaries are the machine's own.
const NOW = new Date(2026, 10, 4, 15, 0);
const daysAgo = (n: number, hour = 10) => new Date(2026, 10, 4 - n, hour).toISOString();

const item = (id: string, timestamp: string): AppNotification => ({
  id,
  kind: "agent-done",
  title: id,
  body: "",
  timestamp,
  source: "agent",
  read: false,
});

describe("dayBucket", () => {
  it("names today and yesterday", () => {
    expect(dayBucket(daysAgo(0), NOW)).toBe("Today");
    expect(dayBucket(daysAgo(1, 23), NOW)).toBe("Yesterday");
  });

  it("names the weekday within a week, a date beyond it", () => {
    const three = new Date(daysAgo(3));
    expect(dayBucket(three.toISOString(), NOW)).toBe(
      three.toLocaleDateString(undefined, { weekday: "long" }),
    );
    const ten = new Date(daysAgo(10));
    expect(dayBucket(ten.toISOString(), NOW)).toBe(
      ten.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });
});

describe("groupNotificationsByDay", () => {
  it("keeps the given order and puts consecutive same-day items in one group", () => {
    const groups = groupNotificationsByDay(
      [
        item("a", daysAgo(0, 14)),
        item("b", daysAgo(0, 9)),
        item("c", daysAgo(1)),
        item("d", daysAgo(10)),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ["Today", ["a", "b"]],
      ["Yesterday", ["c"]],
      [
        new Date(daysAgo(10)).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        ["d"],
      ],
    ]);
  });

  it("is empty for no items", () => {
    expect(groupNotificationsByDay([], NOW)).toEqual([]);
  });
});
