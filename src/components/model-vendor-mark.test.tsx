// @vitest-environment happy-dom
//
// The vendor table is the contract: the usage tables' tints and the model chip
// both read `modelVendorOf`, so a model must classify the same way for both.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { modelVendorOf } from "@/features/agents/lib/agent-brand";
import { ModelChip, ModelVendorMark } from "./model-vendor-mark";

afterEach(cleanup);

describe("modelVendorOf", () => {
  it.each([
    ["claude-sonnet-4-5", "claude"],
    ["gpt-5", "codex"],
    ["gemini-2.5-pro", "gemini"],
    ["llama-3.3-70b", "local"],
    ["mock-model", null],
  ])("%s → %s", (model, vendor) => {
    expect(modelVendorOf(model)).toBe(vendor);
  });
});

describe("ModelVendorMark", () => {
  it.each(["claude-sonnet-4-5", "gpt-5", "cursor-small", "kilo-code"])(
    "%s draws its vendor's glyph, tinted",
    (model) => {
      const { container } = render(<ModelVendorMark model={model} />);
      const svg = container.querySelector("svg");
      expect(svg).toBeTruthy();
      expect(svg?.getAttribute("style")).toContain("color");
      expect(container.querySelector("[aria-hidden]")).toBeTruthy();
    },
  );

  it.each(["gemini-2.5-pro", "llama-3.3-70b"])("%s draws a dot in its hue", (model) => {
    const { container } = render(<ModelVendorMark model={model} />);
    expect(container.querySelector("svg")).toBeNull();
    const dot = container.querySelector(".rounded-full") as HTMLElement;
    expect(dot.style.background).not.toBe("");
  });

  it("an unknown model draws the neutral chip glyph", () => {
    const { container } = render(<ModelVendorMark model="mock-model" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.vendor).toBe("unknown");
    expect(container.querySelector("svg")?.getAttribute("class")).toContain(
      "text-muted-foreground",
    );
  });
});

describe("ModelChip", () => {
  it("tints a known vendor inline and shows the label", () => {
    const { container, getByText } = render(<ModelChip model="gpt-5" label="GPT-5" />);
    const chip = container.querySelector('[data-slot="model-chip"]') as HTMLElement;
    expect(getByText("GPT-5")).toBeTruthy();
    expect(chip.style.color).not.toBe("");
  });

  it("falls back to the themeable chip fill for an unknown model", () => {
    const { container } = render(<ModelChip model="mock-model" label="Mock" />);
    const chip = container.querySelector('[data-slot="model-chip"]') as HTMLElement;
    expect(chip.getAttribute("style")).toBeNull();
    expect(chip.className).toContain("bg-(--agent-chip-background)");
  });
});
