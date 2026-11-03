import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TipsState } from "../lib/tips-api";

const api = vi.hoisted(() => ({
  loadTips: vi.fn<() => Promise<TipsState>>(),
  markTipsSeen: vi.fn<(ids: string[]) => Promise<TipsState>>(),
  resetTips: vi.fn<(keep: string[]) => Promise<TipsState>>(),
}));
vi.mock("../lib/tips-api", () => api);

const { useTipsStore } = await import("./tips-store");
const actions = () => useTipsStore.getState().actions;

const state = (over: Partial<TipsState> = {}): TipsState => ({
  version: 1,
  cohort: "fresh",
  seen: [],
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  api.loadTips.mockResolvedValue(state());
  api.markTipsSeen.mockImplementation(async (ids) => state({ seen: ids }));
  api.resetTips.mockImplementation(async (keep) => state({ seen: keep }));
  useTipsStore.setState(useTipsStore.getInitialState());
  await actions().load();
});

describe("tips store", () => {
  it("queues a requested tip once, and never one already seen", () => {
    actions().request("composer");
    actions().request("composer");
    expect(useTipsStore.getState().queue).toEqual(["composer"]);

    actions().applyRemote(state({ seen: ["palette"] }));
    actions().request("palette");
    expect(useTipsStore.getState().queue).toEqual(["composer"]);
  });

  it("takes a started tip off the queue and records when it appeared", () => {
    actions().request("composer");
    actions().start("composer", 1_000);
    const s = useTipsStore.getState();
    expect(s.active).toEqual({ id: "composer", step: 0 });
    expect(s.queue).toEqual([]);
    expect(s.lastShownAt).toBe(1_000);
  });

  it("marks a tip seen when it is finished, however it was closed", async () => {
    actions().request("composer");
    actions().start("composer", 1_000);
    await actions().finish();
    expect(useTipsStore.getState().active).toBeNull();
    expect(useTipsStore.getState().seen).toContain("composer");
    expect(api.markTipsSeen).toHaveBeenCalledWith(["composer"]);
  });

  it("puts a tip back, unseen and without spending the gap, when its anchor goes away", () => {
    actions().request("composer");
    actions().start("composer", 5_000);
    actions().anchorLost();
    const s = useTipsStore.getState();
    expect(s.active).toBeNull();
    expect(s.queue).toEqual(["composer"]);
    expect(s.lastShownAt).toBeNull();
    expect(s.seen).not.toContain("composer");
    expect(api.markTipsSeen).not.toHaveBeenCalled();
  });

  it("keeps a tip asked for by name asked-for, not queued, when its anchor goes away", () => {
    actions().showByName("composer");
    actions().start("composer", 1_000);
    actions().anchorLost();
    const s = useTipsStore.getState();
    expect(s.forced).toBe("composer");
    expect(s.queue).toEqual([]);
  });

  it("clears a tip asked for by name once it starts", () => {
    actions().showByName("composer");
    expect(useTipsStore.getState().forced).toBe("composer");
    actions().start("composer", 1_000);
    expect(useTipsStore.getState().forced).toBeNull();
  });

  it("replays by adopting what Rust kept", async () => {
    actions().applyRemote(state({ cohort: "upgrade", seen: ["composer"] }));
    await actions().replayAll();
    expect(api.resetTips).toHaveBeenCalledWith([]);
    expect(useTipsStore.getState().seen).toEqual([]);
    expect(useTipsStore.getState().cohort).toBe("fresh");
  });
});
