import { describe, expect, it } from "vitest";
import { composerPillClass, composerPillLabelClass } from "./composer-pill-class";

describe("composerPillClass", () => {
  it("draws an open pill as selected", () => {
    expect(composerPillClass(true)).toContain("bg-element-selected");
    expect(composerPillClass(true)).toContain("text-foreground");
  });

  it("draws a closed pill on the card with a hover", () => {
    const cls = composerPillClass(false);
    expect(cls).toContain("bg-card");
    expect(cls).toContain("hover:bg-element-hover");
  });

  it("gives a disabled pill no hover and no pointer", () => {
    const cls = composerPillClass(false, { disabled: true });
    expect(cls).toContain("cursor-default");
    expect(cls).not.toContain("hover:");
  });

  it("writes theme tokens, never a raw variable", () => {
    expect(composerPillClass(true)).not.toContain("var(--");
    expect(composerPillClass(false)).not.toContain("var(--");
  });
});

describe("composerPillLabelClass", () => {
  it("collapses early labels before late ones", () => {
    expect(composerPillLabelClass("early")).toContain("@[640px]:inline");
    expect(composerPillLabelClass("late")).toContain("@[460px]:inline");
    expect(composerPillLabelClass()).not.toContain("hidden");
  });
});
