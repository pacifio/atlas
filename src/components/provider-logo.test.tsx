// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProviderLogo } from "./provider-logo";

describe("ProviderLogo", () => {
  it("renders a decorative img for orcarouter provider", () => {
    const { container } = render(<ProviderLogo id="orcarouter" size={18} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("aria-hidden")).toBe("true");
    expect(img?.getAttribute("width")).toBe("18");
  });

  it("renders a fallback icon for unknown provider", () => {
    const { container } = render(<ProviderLogo id="unknown-provider" size={18} />);
    const img = container.querySelector("img");
    expect(img).toBeNull();
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
  });
});
