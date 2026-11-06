// @vitest-environment happy-dom
//
// The meter's one real rule: tone goes by POSITION, not by fill level. A run
// that reached 92% still shows green where it was comfortable and red only at
// the end, so you can see *where* it crossed. Colouring the whole bar by its
// final figure would say the whole run was in trouble.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ContextMeter } from "./context-meter";

afterEach(cleanup);

/** The tick spans, in order. happy-dom reports no width, so the meter draws
 *  its unmeasured 24. */
function ticks() {
  return Array.from(screen.getByRole("meter").querySelectorAll("span")).filter((el) =>
    el.className.includes("flex-1"),
  );
}

const lit = () => ticks().filter((el) => !el.className.includes("opacity-20"));

describe("ContextMeter", () => {
  it("reports the share as a percentage and a fraction", () => {
    render(<ContextMeter used={633_900} size={1_000_000} />);
    expect(screen.getByText("63%")).toBeTruthy();
    expect(screen.getByText("633.9K/1.00M")).toBeTruthy();
    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuenow")).toBe("633900");
    expect(meter.getAttribute("aria-valuemax")).toBe("1000000");
  });

  it("tones by position, so a full bar still shows where it crossed", () => {
    render(<ContextMeter used={1_000_000} size={1_000_000} />);
    const classes = ticks().map((el) => el.className);
    // 24 unmeasured ticks: green below 18, amber from 18, red from 22.
    expect(classes[0]).toContain("bg-success");
    expect(classes[17]).toContain("bg-success");
    expect(classes[18]).toContain("bg-warning");
    expect(classes[21]).toContain("bg-warning");
    expect(classes[22]).toContain("bg-error");
  });

  it("lights one tick for any use at all, and none for none", () => {
    render(<ContextMeter used={1} size={1_000_000} />);
    expect(lit()).toHaveLength(1);
    cleanup();
    render(<ContextMeter used={0} size={1_000_000} />);
    expect(lit()).toHaveLength(0);
  });

  it("clamps a window that was already overrun", () => {
    render(<ContextMeter used={2_000_000} size={1_000_000} />);
    expect(screen.getByText("100%")).toBeTruthy();
    expect(lit()).toHaveLength(ticks().length);
  });

  it("does not divide by a window of zero", () => {
    render(<ContextMeter used={10} size={0} />);
    expect(screen.getByText("0%")).toBeTruthy();
  });
});
