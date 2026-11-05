import { describe, expect, it } from "vitest";

import type { NotificationEnv } from "@/features/notifications/lib/decide";

import { decideGuideRun, type GuideRunOutcome } from "./guide-notifier-rules";

const env = (over: Partial<NotificationEnv> = {}): NotificationEnv => ({
  windowFocused: true,
  sinceInputMs: 1_000,
  targetVisible: false,
  projectActive: true,
  away: false,
  ...over,
});

const ready: GuideRunOutcome = {
  repoPath: "/repo",
  number: 87,
  title: "Add discounts",
  failure: null,
  seq: 1,
};

describe("decideGuideRun", () => {
  it("toasts a ready guide with Open, at the pull request's Guide", () => {
    const d = decideGuideRun(ready, env(), {});
    expect(d).not.toBeNull();
    expect(d!.title).toBe("Review guide ready");
    expect(d!.body).toBe("#87 Add discounts");
    expect(d!.channels.toast).toBe(true);
    expect(d!.channels.native).toBe(false);
    expect(d!.actions.map((a) => a.label)).toEqual(["Open"]);
    expect(d!.target).toEqual({
      type: "pull-request",
      repoPath: "/repo",
      number: 87,
      title: "Add discounts",
      view: "guide",
    });
  });

  it("says why a run failed", () => {
    const d = decideGuideRun({ ...ready, failure: "The agent stopped\nwith an error." }, env(), {});
    expect(d!.title).toBe("Review guide failed");
    expect(d!.body).toBe("#87 Add discounts: The agent stopped with an error.");
  });

  it("raises an OS banner while the user is away", () => {
    const d = decideGuideRun(ready, env({ windowFocused: false, away: true }), {});
    expect(d!.channels.native).toBe(true);
  });

  it("says nothing while that pull request's Guide is on screen", () => {
    expect(decideGuideRun(ready, env({ targetVisible: true }), {})).toBeNull();
  });

  it("respects the kind's switch in Settings", () => {
    const off = { "pull-request-guide": { enabled: false, native: true, sound: false } };
    expect(decideGuideRun(ready, env(), off)).toBeNull();
  });

  it("gives each run's end its own key, and names an untitled pull request", () => {
    const a = decideGuideRun({ ...ready, title: null }, env(), {});
    const b = decideGuideRun({ ...ready, title: null, seq: 2 }, env(), {});
    expect(a!.body).toBe("Pull request #87");
    expect(a!.dedupeKey).not.toBe(b!.dedupeKey);
  });
});
