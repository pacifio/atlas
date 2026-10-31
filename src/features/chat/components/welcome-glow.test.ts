import { describe, expect, it } from "vitest";
import { pickWelcomePalette, WELCOME_PALETTE } from "./welcome-glow";

describe("pickWelcomePalette", () => {
  it("never shows the same hue twice in a row", () => {
    let previous = pickWelcomePalette();
    for (let i = 0; i < 200; i++) {
      const next = pickWelcomePalette();
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  it("reaches every hue, the edges of the random range included", () => {
    const seen = new Set<string>();
    for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.9999, 0, 0.9999, 0.5, 0.3]) {
      seen.add(pickWelcomePalette(() => r));
    }
    expect(seen.size).toBe(WELCOME_PALETTE.length);
  });
});
