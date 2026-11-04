import { describe, expect, it } from "vitest";
import { COVER_GRADIENTS, gradientCss, isGradientCover } from "./cover-gradients";

describe("cover gradients", () => {
  it("keeps the six persisted ids", () => {
    // These ids live in users' `_meta.json`; renaming one drops a cover.
    expect(COVER_GRADIENTS.map((g) => g.id)).toEqual([
      "gradient:slate-1",
      "gradient:warm-1",
      "gradient:moss-1",
      "gradient:dusk-1",
      "gradient:rose-1",
      "gradient:gold-1",
    ]);
  });

  it("resolves a known id and nothing else", () => {
    expect(gradientCss("gradient:dusk-1")).not.toBeNull();
    expect(gradientCss("gradient:nope")).toBeNull();
    expect(gradientCss("covers/welcome.png")).toBeNull();
  });

  it("tells a gradient ref from an image ref", () => {
    expect(isGradientCover("gradient:moss-1")).toBe(true);
    expect(isGradientCover("covers/welcome.png")).toBe(false);
    expect(isGradientCover(null)).toBe(false);
  });
});
