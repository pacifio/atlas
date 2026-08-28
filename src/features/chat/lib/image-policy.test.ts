import { describe, expect, it } from "vitest";
import {
  BODY_CAP_BYTES,
  MAX_EDGE_PX,
  PER_IMAGE_BUDGET_BYTES,
  encodedSize,
  exceedsBudget,
  targetDimensions,
} from "./image-policy";

describe("image sizing policy (D15c)", () => {
  it("leaves an image that is already small enough alone", () => {
    // Re-encoding a small screenshot costs quality and buys nothing. The common
    // case has to be a no-op or the policy makes every paste worse.
    expect(targetDimensions(800, 600)).toBeNull();
    expect(targetDimensions(MAX_EDGE_PX, 400)).toBeNull();
  });

  it("shrinks the longest edge and keeps the aspect ratio", () => {
    // Distorting a screenshot to hit a budget makes it harder to read, which
    // defeats the point of sending it.
    const wide = targetDimensions(3200, 1600);
    expect(wide).toEqual({ width: 1568, height: 784 });

    const tall = targetDimensions(1000, 4000);
    expect(tall).toEqual({ width: 392, height: 1568 });
  });

  it("never rounds a dimension down to zero", () => {
    // A 1px-tall banner scaled by 0.05 rounds to 0, and a canvas of zero height
    // draws nothing at all — an attachment that silently becomes blank.
    const sliver = targetDimensions(30000, 10);
    expect(sliver?.height).toBeGreaterThanOrEqual(1);
    expect(sliver?.width).toBe(MAX_EDGE_PX);
  });

  it("treats a degenerate image as nothing to do rather than dividing by zero", () => {
    expect(targetDimensions(0, 0)).toBeNull();
  });

  it("measures the budget in base64, because base64 is what travels", () => {
    // The gateway counts the body it receives, before parsing. Judging by raw
    // bytes would let an image a third over the line through.
    expect(encodedSize(3)).toBe(4);
    expect(encodedSize(1024 * 1024)).toBeGreaterThan(1024 * 1024);
  });

  it("budgets one image at a fraction of the cap, not the whole of it", () => {
    // The body also carries the system prompt, the tool schemas and the whole
    // conversation so far — and a user attaching two images in one turn must
    // not be refused for it.
    expect(PER_IMAGE_BUDGET_BYTES).toBeLessThan(BODY_CAP_BYTES);
    expect(exceedsBudget(PER_IMAGE_BUDGET_BYTES)).toBe(false);
    expect(exceedsBudget(PER_IMAGE_BUDGET_BYTES + 1)).toBe(true);
  });

  it("would reject a typical unscaled screenshot", () => {
    // The case this exists for: a 4 MB retina screenshot, ~5.3 MB once base64
    // encoded, against a 2 MB cap.
    expect(exceedsBudget(encodedSize(4 * 1024 * 1024))).toBe(true);
  });
});
