// The art stands in for a face, so its one contract is that it is STABLE: the
// same guest is recognisable across their remarks and across launches, and two
// guests are told apart. Everything else about it is taste.

import { describe, expect, it } from "vitest";

import { ART_BOX, generatedArt } from "./generated-art";

describe("generatedArt", () => {
  it("draws the same art for the same seed, every time", () => {
    expect(generatedArt("guest_a")).toEqual(generatedArt("guest_a"));
  });

  it("draws something else for a different seed", () => {
    const a = generatedArt("guest_a");
    const b = generatedArt("guest_b");
    // Not a deep inequality — two seeds could legitimately share a pattern.
    // The art as a whole must differ.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("keeps every dot inside the box it is drawn in", () => {
    // The caller clips it to a circle; a dot outside the viewBox is a dot
    // nobody sees and a radius that quietly does nothing.
    for (const seed of ["a", "b", "c", "guest_1", "u_long_identifier", ""]) {
      for (const d of generatedArt(seed).dots) {
        expect(d.x).toBeGreaterThanOrEqual(-ART_BOX);
        expect(d.x).toBeLessThanOrEqual(ART_BOX * 2);
        expect(d.y).toBeGreaterThanOrEqual(-ART_BOX);
        expect(d.y).toBeLessThanOrEqual(ART_BOX * 2);
        expect(d.r).toBeGreaterThan(0);
        expect(d.o).toBeGreaterThan(0);
        expect(d.o).toBeLessThanOrEqual(1);
      }
    }
  });

  it("always has something to draw", () => {
    for (const seed of ["", "a", "zzzz", "guest_42"]) {
      expect(generatedArt(seed).dots.length).toBeGreaterThan(0);
      expect(generatedArt(seed).stops).toHaveLength(3);
    }
  });
});
