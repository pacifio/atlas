import { describe, expect, it, vi } from "vitest";
import { createBannerCoalescer, mergeBanners } from "./banner-coalescer";
import type { NotificationDecision } from "./decide";

const decision = (title: string, key: string): NotificationDecision => ({
  kind: "agent-done",
  tier: "outcome",
  title,
  body: "Task finished.",
  target: { type: "session", tabId: key },
  dedupeKey: key,
  groupKey: `session:${key}`,
  actions: [{ id: "open", label: "Open" }],
  channels: { center: true, toast: true, native: true, badge: true, sound: false },
  toast: { variant: "success", durationMs: 5_000 },
  native: { title: "Atlas: atlas", body: `${title} — Task finished.` },
});

describe("createBannerCoalescer", () => {
  it("emits a lone banner unchanged after the window", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const c = createBannerCoalescer({ windowMs: 3_000, emit });
    const d = decision("A", "a");
    c.add(d);
    expect(emit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(d);
    vi.useRealTimers();
  });

  it("merges a burst into one banner", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const c = createBannerCoalescer({ windowMs: 3_000, emit });
    c.add(decision("A", "a"));
    vi.advanceTimersByTime(1_000);
    c.add(decision("B", "b"));
    c.add(decision("C", "c"));
    vi.advanceTimersByTime(2_000);
    expect(emit).toHaveBeenCalledOnce();
    const merged = emit.mock.calls[0][0] as NotificationDecision;
    expect(merged.title).toBe("3 agents finished");
    expect(merged.native).toMatchObject({ title: "3 agents finished", body: "A, B, C" });
    vi.useRealTimers();
  });

  it("starts a new window after a flush", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const c = createBannerCoalescer({ windowMs: 1_000, emit });
    c.add(decision("A", "a"));
    vi.advanceTimersByTime(1_000);
    c.add(decision("B", "b"));
    vi.advanceTimersByTime(1_000);
    expect(emit).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("dispose drops what is pending", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const c = createBannerCoalescer({ windowMs: 1_000, emit });
    c.add(decision("A", "a"));
    c.dispose();
    vi.advanceTimersByTime(5_000);
    expect(emit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("mergeBanners", () => {
  it("elides long lists and dedupes titles", () => {
    const m = mergeBanners(["A", "A", "B", "C", "D"].map((t, i) => decision(t, `k${i}`)));
    expect(m.title).toBe("5 agents finished");
    expect(m.body).toBe("A, B, C, …");
  });
});
