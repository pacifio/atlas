// The skills Discover table's 6-month install columns.
//
// The registry gives one lifetime `installs` count and no time series, so the
// TOTAL is real and only the month-to-month shape is synthesized. That split
// has to be exact and stable, or the bars quietly claim a number the row's own
// label contradicts.

import { describe, expect, it } from "vitest";
import { installTrend, TREND_BUCKETS } from "./install-trends";

describe("installTrend", () => {
  it("splits the real total exactly — the bars add up to the number on the row", () => {
    for (const total of [1, 7, 42, 1000, 99_999, 1_234_567]) {
      const { points } = installTrend("some/skill", total);
      expect(points).toHaveLength(TREND_BUCKETS);
      expect(points.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("is stable per skill id across calls", () => {
    // Rendered on every keystroke in the search box; a re-shuffling chart would
    // read as live data that isn't.
    const a = installTrend("anthropic/pdf", 5000);
    const b = installTrend("anthropic/pdf", 5000);
    expect(a.points).toEqual(b.points);
  });

  it("gives different skills different shapes", () => {
    const a = installTrend("anthropic/pdf", 5000);
    const b = installTrend("vercel/next", 5000);
    expect(a.points).not.toEqual(b.points);
  });

  it("stays exact and non-negative at totals smaller than the bucket count", () => {
    // The regression: 26 buckets each get a share below 1 for a small total, so
    // round-then-absorb pushed the last bucket negative and the clamp silently
    // broke the sum. Largest-remainder apportionment cannot do that.
    for (let total = 0; total < 400; total++) {
      const { points } = installTrend(`skill-${total}`, total);
      expect(points.every((m) => m >= 0)).toBe(true);
      expect(points.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it("treats a missing or nonsense count as zero rather than drawing noise", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const t = installTrend("x", bad);
      expect(t.total).toBe(0);
      expect(t.points).toEqual(Array.from({ length: TREND_BUCKETS }, () => 0));
      expect(t.up).toBe(false);
    }
  });

  it("produces both rising and falling skills", () => {
    // The mark is colored by polarity (green up / red down). A drift that was
    // always positive painted every row green, which made the color carry no
    // information at all — the reason this column exists.
    const ids = Array.from({ length: 200 }, (_, i) => `owner/skill-${i}`);
    const rising = ids.filter((id) => installTrend(id, 5000).up).length;
    expect(rising).toBeGreaterThan(0);
    expect(rising).toBeLessThan(ids.length);
    // Most rise — a lifetime counter on a young registry implies recent
    // adoption — but a real minority fall.
    expect(rising / ids.length).toBeGreaterThan(0.4);
    expect(rising / ids.length).toBeLessThan(0.9);
  });

  it("keeps a skill's direction stable across totals", () => {
    // Direction is drawn from the id before anything else touches the generator,
    // so a skill does not flip color as its install count ticks up.
    for (const id of ["anthropic/pdf", "vercel/next", "owner/skill-3"]) {
      const dir = installTrend(id, 1000).up;
      expect(installTrend(id, 250_000).up).toBe(dir);
    }
  });

  it("reports polarity from newest vs oldest bucket", () => {
    const t = installTrend("anthropic/pdf", 5000);
    expect(t.up).toBe(t.points[TREND_BUCKETS - 1] >= t.points[0]);
  });
});
