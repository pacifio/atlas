// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ringDashOffset, UsageRing } from "./usage-meter";

describe("ringDashOffset", () => {
  const c = 2 * Math.PI * 7;

  it("is the unused remainder of the circumference", () => {
    expect(ringDashOffset(0)).toBeCloseTo(c);
    expect(ringDashOffset(0.25)).toBeCloseTo(c * 0.75);
    expect(ringDashOffset(1)).toBeCloseTo(0);
  });

  it("clamps past-full and negative readings so the arc cannot wrap", () => {
    expect(ringDashOffset(1.5)).toBeCloseTo(0);
    expect(ringDashOffset(-0.2)).toBeCloseTo(c);
  });
});

describe("UsageRing", () => {
  it("is a fixed 12 px box so a fill change cannot shift layout", () => {
    const { container, rerender } = render(<UsageRing frac={0.1} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("12");
    expect(svg.getAttribute("height")).toBe("12");
    rerender(<UsageRing frac={0.9} />);
    expect(container.querySelector("svg")).toBe(svg);
    expect(svg.getAttribute("width")).toBe("12");
  });

  it("paints an arc whose dash offset matches the used fraction", () => {
    const { container } = render(<UsageRing frac={0.42} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("data-usage-ring")).toBe("known");
    const fill = svg.querySelectorAll("circle")[1];
    expect(Number(fill.getAttribute("stroke-dashoffset"))).toBeCloseTo(ringDashOffset(0.42));
    expect(fill.getAttribute("stroke-linecap")).toBe("butt");
  });

  it("dashes the track and omits the fill when the agent reports no window", () => {
    const { container } = render(<UsageRing frac={null} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("data-usage-ring")).toBe("unknown");
    const circles = svg.querySelectorAll("circle");
    expect(circles).toHaveLength(1);
    expect(circles[0].getAttribute("stroke-dasharray")).toBe("2.6 2.2");
  });
});
