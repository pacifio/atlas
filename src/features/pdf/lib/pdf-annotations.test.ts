import { describe, expect, it } from "vitest";
import { newAnnotationId, PDF_COLORS, PDF_SWATCHES } from "./pdf-annotations";

describe("pdf-annotations", () => {
  it("keeps the five persisted swatch ids, unique and in order", () => {
    // These strings are written into `.atlas/pdf-annotations.json`; changing
    // one orphans every annotation saved with it.
    expect(PDF_COLORS).toEqual(["#F5C542", "#6796E6", "#5CC28A", "#F44747", "#C4A5E7"]);
    expect(new Set(PDF_COLORS).size).toBe(PDF_COLORS.length);
    expect(PDF_SWATCHES.map((s) => s.id)).toEqual(PDF_COLORS);
  });

  it("mints distinct ann- ids", () => {
    const a = newAnnotationId();
    const b = newAnnotationId();
    expect(a.startsWith("ann-")).toBe(true);
    expect(a).not.toBe(b);
  });
});
