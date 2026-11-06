// @vitest-environment happy-dom
import { createRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GithubIcon } from "./github";

// `globals: false` in vitest.config.ts — auto-cleanup is not registered.
beforeEach(cleanup);

describe("GithubIcon", () => {
  it("forwards its ref to the svg", () => {
    const ref = createRef<SVGSVGElement>();
    render(<GithubIcon ref={ref} />);
    expect(ref.current?.tagName.toLowerCase()).toBe("svg");
  });

  it("sizes width and height from `size`", () => {
    const { container } = render(<GithubIcon size={12} className="x" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("12");
    expect(svg?.getAttribute("height")).toBe("12");
    expect(svg?.getAttribute("class")).toContain("x");
  });
});
