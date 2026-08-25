// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadMemoryTimelineDayCount,
  saveMemoryTimelineDayCount,
} from "./memory-timeline-view-prefs";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    },
  });
  localStorage.clear();
});

describe("memory timeline day-count preference", () => {
  it("defaults to 4 days when storage is missing", () => {
    expect(loadMemoryTimelineDayCount()).toBe(4);
  });

  it.each([3, 4, 7] as const)("restores a valid persisted value: %d", (dayCount) => {
    saveMemoryTimelineDayCount(dayCount);
    expect(loadMemoryTimelineDayCount()).toBe(dayCount);
  });

  it.each(["", "2", "5", "three", "null"])(
    "falls back to 4 for an invalid persisted value: %j",
    (value) => {
      localStorage.setItem("atlas-memory-timeline-day-count", value);
      expect(loadMemoryTimelineDayCount()).toBe(4);
    },
  );

  it("persists a changed valid value for the next mount", () => {
    saveMemoryTimelineDayCount(7);
    expect(loadMemoryTimelineDayCount()).toBe(7);
    saveMemoryTimelineDayCount(3);
    expect(loadMemoryTimelineDayCount()).toBe(3);
  });
});
