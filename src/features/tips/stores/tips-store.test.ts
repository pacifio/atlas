import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TipsState } from "../lib/tips-api";

const api = vi.hoisted(() => ({
  loadTips: vi.fn<() => Promise<TipsState>>(),
  markTipSeen: vi.fn<(id: string, outcome: string) => Promise<TipsState>>(),
  resetTips: vi.fn<(keep: string[]) => Promise<TipsState>>(),
  reportTipShown: vi.fn(async () => {}),
  completeChecklistItem: vi.fn<(item: string) => Promise<TipsState>>(),
  dismissGetStarted: vi.fn<() => Promise<TipsState>>(),
}));
vi.mock("../lib/tips-api", () => api);

const { useTipsStore } = await import("./tips-store");
const actions = () => useTipsStore.getState().actions;

const state = (over: Partial<TipsState> = {}): TipsState => ({
  version: 1,
  cohort: "fresh",
  seen: [],
  checklist: [],
  checklistDismissed: false,
  activeDays: [],
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  api.loadTips.mockResolvedValue(state());
  api.markTipSeen.mockImplementation(async (id) => state({ seen: [id] }));
  api.completeChecklistItem.mockImplementation(async (item) => state({ checklist: [item] }));
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
    expect(api.markTipSeen).toHaveBeenCalledWith("composer", "dismissed");
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
    expect(api.markTipSeen).not.toHaveBeenCalled();
  });

  it("keeps a tip asked for by name asked-for, not queued, when its anchor goes away", () => {
    actions().showByName("composer");
    actions().start("composer", 1_000);
    actions().anchorLost();
    const s = useTipsStore.getState();
    expect(s.forced).toBe("composer");
    expect(s.queue).toEqual([]);
  });

  it("withdraws a tip that is no longer true, unseen, wherever it waits", () => {
    actions().request("sign-in");
    actions().withdraw("sign-in");
    expect(useTipsStore.getState().queue).toEqual([]);

    actions().request("capture");
    actions().start("capture", 5_000);
    actions().withdraw("capture");
    const s = useTipsStore.getState();
    expect(s.active).toBeNull();
    expect(s.lastShownAt).toBeNull();
    expect(api.markTipSeen).not.toHaveBeenCalled();
  });

  it("skips Get started only for an upgrader who already had a project", async () => {
    const decide = async (over: Partial<TipsState>, hasProject: boolean) => {
      useTipsStore.setState(useTipsStore.getInitialState());
      api.loadTips.mockResolvedValueOnce(state(over));
      await actions().load();
      actions().decideGetStarted(hasProject);
      actions().decideGetStarted(!hasProject); // decided once
      return useTipsStore.getState().getStartedSkipped;
    };
    expect(await decide({ cohort: "upgrade" }, true)).toBe(true);
    expect(await decide({ cohort: "upgrade" }, false)).toBe(false);
    expect(await decide({ cohort: "upgrade", checklist: ["add-project"] }, true)).toBe(false);
    expect(await decide({ cohort: "fresh" }, true)).toBe(false);
  });

  it("clears a tip asked for by name once it starts", () => {
    actions().showByName("composer");
    expect(useTipsStore.getState().forced).toBe("composer");
    actions().start("composer", 1_000);
    expect(useTipsStore.getState().forced).toBeNull();
  });

  it("replays by adopting what Rust kept", async () => {
    actions().applyRemote(state({ cohort: "upgrade", seen: ["composer", "sign-in"] }));
    api.resetTips.mockResolvedValueOnce(state({ seen: ["sign-in"] }));
    await actions().replayAll();
    // The sign-in tip and the star prompt are asked once, ever.
    expect(api.resetTips).toHaveBeenCalledWith(["sign-in", "star-github"]);
    expect(useTipsStore.getState().seen).toEqual(["sign-in"]);
    expect(useTipsStore.getState().cohort).toBe("fresh");
  });

  it("records a tip finished from its own button as done", async () => {
    actions().request("composer");
    actions().start("composer", 1_000);
    await actions().finish("done");
    expect(api.markTipSeen).toHaveBeenCalledWith("composer", "done");
  });

  it("completes a Get started item once", async () => {
    await actions().completeItem("add-project");
    await actions().completeItem("add-project");
    expect(api.completeChecklistItem).toHaveBeenCalledTimes(1);
    expect(useTipsStore.getState().checklist).toEqual(["add-project"]);
  });
});
