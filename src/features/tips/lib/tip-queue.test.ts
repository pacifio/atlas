import { describe, expect, it } from "vitest";
import { pickNextTip, TIP_GAP_MS, type QueueInput } from "./tip-queue";
import type { TipDef } from "./tip-registry";

const tip = (id: string, kind: TipDef["kind"] = "surface"): TipDef => ({
  id,
  kind,
  replayable: true,
  anchor: id,
  steps: [{ title: id, body: id }],
});

const REGISTRY: Record<string, TipDef> = {
  composer: tip("composer"),
  palette: tip("palette"),
  capture: tip("capture", "moment"),
};

function input(over: Partial<QueueInput> = {}): QueueInput {
  return {
    queue: ["composer"],
    forced: null,
    seen: new Set(),
    cohort: "fresh",
    enabled: true,
    now: 10 * 60_000,
    lastShownAt: null,
    busy: false,
    focused: true,
    anchorVisible: () => true,
    ...over,
  };
}

describe("pickNextTip", () => {
  it("shows the first requested tip when nothing holds it", () => {
    expect(pickNextTip(input(), REGISTRY)).toBe("composer");
  });

  it("never shows a tip the user has already seen", () => {
    expect(pickNextTip(input({ seen: new Set(["composer"]) }), REGISTRY)).toBeNull();
  });

  it("waits out the gap after the last tip, then shows the next", () => {
    const lastShownAt = 10 * 60_000;
    const early = input({ lastShownAt, now: lastShownAt + TIP_GAP_MS - 1 });
    const later = input({ lastShownAt, now: lastShownAt + TIP_GAP_MS });
    expect(pickNextTip(early, REGISTRY)).toBeNull();
    expect(pickNextTip(later, REGISTRY)).toBe("composer");
  });

  it("is three minutes between tips", () => {
    expect(TIP_GAP_MS).toBe(180_000);
  });

  it("holds every tip while the user is busy or the window is not focused", () => {
    expect(pickNextTip(input({ busy: true }), REGISTRY)).toBeNull();
    expect(pickNextTip(input({ focused: false }), REGISTRY)).toBeNull();
  });

  it("shows nothing when tips are switched off", () => {
    expect(pickNextTip(input({ enabled: false }), REGISTRY)).toBeNull();
  });

  it("puts a moment tip ahead of surface tips requested earlier", () => {
    const q = input({ queue: ["composer", "palette", "capture"] });
    expect(pickNextTip(q, REGISTRY)).toBe("capture");
  });

  it("keeps request order among tips of the same kind", () => {
    expect(pickNextTip(input({ queue: ["palette", "composer"] }), REGISTRY)).toBe("palette");
  });

  it("skips a tip whose anchor is off screen and shows the next one that is on screen", () => {
    const q = input({
      queue: ["composer", "palette"],
      anchorVisible: (id) => id === "palette",
    });
    expect(pickNextTip(q, REGISTRY)).toBe("palette");
  });

  it("gives someone who upgraded only moment tips", () => {
    const q = input({ cohort: "upgrade", queue: ["composer", "capture"] });
    expect(pickNextTip(q, REGISTRY)).toBe("capture");
    expect(pickNextTip(input({ cohort: "upgrade" }), REGISTRY)).toBeNull();
  });

  it("ignores ids that are not in the registry", () => {
    expect(pickNextTip(input({ queue: ["gone"] }), REGISTRY)).toBeNull();
  });

  describe("a tip asked for by name (Show tip…)", () => {
    it("shows even when seen, switched off, upgraded, busy or inside the gap", () => {
      const q = input({
        queue: [],
        forced: "composer",
        seen: new Set(["composer"]),
        enabled: false,
        cohort: "upgrade",
        busy: true,
        lastShownAt: 10 * 60_000,
      });
      expect(pickNextTip(q, REGISTRY)).toBe("composer");
    });

    it("still waits for its anchor and for the window to be focused", () => {
      expect(
        pickNextTip(input({ forced: "composer", anchorVisible: () => false }), REGISTRY),
      ).toBeNull();
      expect(pickNextTip(input({ forced: "composer", focused: false }), REGISTRY)).toBeNull();
    });

    it("does not hold up the queue while its own anchor is off screen", () => {
      const q = input({
        queue: ["composer"],
        forced: "palette",
        anchorVisible: (id) => id === "composer",
      });
      expect(pickNextTip(q, REGISTRY)).toBe("composer");
    });

    it("goes ahead of anything queued", () => {
      const q = input({ queue: ["capture"], forced: "palette" });
      expect(pickNextTip(q, REGISTRY)).toBe("palette");
    });
  });
});
