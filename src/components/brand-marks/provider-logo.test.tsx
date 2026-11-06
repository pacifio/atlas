// @vitest-environment happy-dom
import { beforeEach, describe, it, expect } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ProviderLogo } from "./provider-logo";

// `globals: false` in vitest.config.ts — auto-cleanup is not registered.
beforeEach(cleanup);

describe("ProviderLogo", () => {
  it("draws a package mark at the requested size", () => {
    const { container } = render(<ProviderLogo id="anthropic" size={13} />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    expect(svgs[0].getAttribute("width")).toBe("13");
    expect(container.querySelector("img")).toBeNull();
  });

  it("draws Google's mark as an svg", () => {
    const { container } = render(<ProviderLogo id="google" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

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
