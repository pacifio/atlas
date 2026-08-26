export type MemoryTimelineDayCount = 3 | 4 | 7;

const DAY_COUNT_KEY = "atlas-memory-timeline-day-count";

export function loadMemoryTimelineDayCount(): MemoryTimelineDayCount {
  try {
    const value = localStorage.getItem(DAY_COUNT_KEY);
    return value === "3" ? 3 : value === "7" ? 7 : 4;
  } catch {
    return 4;
  }
}

export function saveMemoryTimelineDayCount(dayCount: MemoryTimelineDayCount) {
  try {
    localStorage.setItem(DAY_COUNT_KEY, String(dayCount));
  } catch {
    /* ignore */
  }
}
