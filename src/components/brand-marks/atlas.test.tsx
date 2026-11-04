// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AtlasIcon } from "./atlas";

// `globals: false` in vitest.config.ts — auto-cleanup is not registered.
beforeEach(cleanup);

describe("AtlasIcon", () => {
  it("draws the badge, tile and all, at a large size", () => {
    const { container } = render(<AtlasIcon size={64} className="rounded-2xl" />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.getAttribute("aria-label")).toBe("Atlas");
    expect(frame.style.width).toBe("64px");
    expect(frame.className).toContain("rounded-2xl");
    expect(frame.querySelector("div > svg")).not.toBeNull();
  });

  it("switches from the bare mark to the badge at 32px", () => {
    const below = render(<AtlasIcon size={31} />).container.firstElementChild;
    expect(below?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    cleanup();
    const at = render(<AtlasIcon size={32} />).container.firstElementChild;
    expect(at?.firstElementChild?.tagName).toBe("DIV");
  });

  it("draws the bare mark at a small size", () => {
    const { container } = render(<AtlasIcon size={12} alt="Agent" />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.getAttribute("aria-label")).toBe("Agent");
    expect(frame.style.width).toBe("12px");
    expect(frame.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });
});
