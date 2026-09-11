// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TitlebarDock, type DockItem } from "./titlebar-dock";

/**
 * happy-dom reports every rect as zero, and the whole tooltip is arithmetic
 * over rects — so each element gets a measured box here. Labels are given
 * distinct widths so a loop that sums the wrong range is visible in the result
 * rather than cancelling out.
 */
function measure(el: Element, box: { left: number; width: number }) {
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...box, right: box.left + box.width, top: 0, bottom: 22, height: 22 }),
  });
}

const items: DockItem[] = [
  { label: "Check for updates", icon: <i />, onClick: vi.fn() },
  { label: "Notifications", icon: <i />, onClick: vi.fn() },
  { label: "Hide right panel", icon: <i />, onClick: vi.fn() },
];

/**
 * Lay the dock out: labels 40/60/80 (total 180) on an anchor starting at 100.
 *
 * The anchor is measured, NOT the strip. That distinction is the bug this
 * suite exists to hold: the strip is the element being translated, so reading
 * its rect as the origin folds the previous offset into the next one and every
 * hover drifts further. The anchor here is given a FIXED rect while the strip
 * deliberately gets none, so any code that measures the strip reads zeros and
 * fails loudly.
 */
function layout(container: HTMLElement, iconCentres = [120, 200, 280]) {
  const strip = container.querySelector("[style*='clip-path']") as HTMLElement;
  measure(strip.parentElement!, { left: 100, width: 180 });
  const labels = [...strip.children];
  [40, 60, 80].forEach((width, i) => measure(labels[i], { left: 0, width }));
  const buttons = [...container.querySelectorAll("button")];
  buttons.forEach((b, i) => measure(b, { left: iconCentres[i] - 12, width: 24 }));
  return { strip, buttons };
}

const translateX = (el: HTMLElement) =>
  Number(/translateX\(([-\d.]+)px\)/.exec(el.style.transform)![1]);
const insets = (el: HTMLElement) => {
  const m = /inset\(0 ([\d.]+)% 0 ([\d.]+)%/.exec(el.style.clipPath)!;
  return { right: Number(m[1]), left: Number(m[2]) };
};

afterEach(cleanup);

describe("TitlebarDock", () => {
  it("renders one button per item, named for the tooltip", () => {
    render(<TitlebarDock items={items} />);
    expect(screen.getByLabelText("Notifications")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });

  it("invokes the item's action on click", () => {
    render(<TitlebarDock items={items} />);
    fireEvent.click(screen.getByLabelText("Notifications"));
    expect(items[1].onClick).toHaveBeenCalledTimes(1);
  });

  it("is invisible until something is hovered", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const strip = container.querySelector("[style*='clip-path']") as HTMLElement;
    expect(strip.style.opacity).toBe("0");
  });

  it("clips away every label but the hovered one", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { strip, buttons } = layout(container);

    fireEvent.mouseEnter(buttons[1]);
    // 40 of 180 to the left, 80 of 180 to the right.
    expect(insets(strip)).toEqual({ left: (40 / 180) * 100, right: (80 / 180) * 100 });
    expect(strip.style.opacity).toBe("1");
  });

  it("shows the first label with nothing clipped on its left", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { strip, buttons } = layout(container);
    fireEvent.mouseEnter(buttons[0]);
    expect(insets(strip)).toEqual({ left: 0, right: ((60 + 80) / 180) * 100 });
  });

  it("centres the hovered label on its icon", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { strip, buttons } = layout(container);

    fireEvent.mouseEnter(buttons[1]);
    // strip left 100 + 40 before + half of 60 = 170; icon centre 200.
    expect(translateX(strip)).toBe(30);
  });

  it("pulls the tooltip back inside the window at the right edge", () => {
    const { container } = render(<TitlebarDock items={items} />);
    // Last icon near the edge: its 80px label would otherwise overhang.
    const { strip, buttons } = layout(container, [120, 200, window.innerWidth - 10]);

    fireEvent.mouseEnter(buttons[2]);
    const centre = window.innerWidth - 10;
    const unclamped = centre - (100 + 40 + 60 + 40);
    const overflow = centre + 40 - (window.innerWidth - 8);
    expect(translateX(strip)).toBe(unclamped - overflow);
    // Which is to say: its right edge lands exactly on the margin.
    expect(100 + 100 + translateX(strip) + 80).toBe(window.innerWidth - 8);
  });

  it("materialises in place on first hover, then animates between items", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { strip, buttons } = layout(container);

    fireEvent.mouseEnter(buttons[0]);
    // Nothing to travel from yet — a transform transition here would fly the
    // tooltip in from the origin.
    expect(strip.style.transition).not.toContain("transform");

    fireEvent.mouseEnter(buttons[1]);
    expect(strip.style.transition).toContain("transform");
    expect(strip.style.transition).toContain("clip-path");
  });

  it("fades out without moving, so the next hover travels from here", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { strip, buttons } = layout(container);
    fireEvent.mouseEnter(buttons[1]);
    const held = strip.style.transform;

    fireEvent.mouseLeave(container.firstElementChild as HTMLElement);
    expect(strip.style.opacity).toBe("0");
    expect(strip.style.transform).toBe(held);
  });

  it("stays silent when nothing can be measured", () => {
    // The zero-rect case: a hidden titlebar, or a hover before layout. Better
    // to show no tooltip than one stacked at the origin.
    const { container } = render(<TitlebarDock items={items} />);
    const strip = container.querySelector("[style*='clip-path']") as HTMLElement;
    fireEvent.mouseEnter(screen.getAllByRole("button")[1]);
    expect(strip.style.opacity).toBe("0");
  });

  it("hosts a trailing control and gives it a tooltip of its own", () => {
    const { container } = render(
      <TitlebarDock
        items={items}
        trailing={{ label: "Account", node: <button aria-label="Account" /> }}
      />,
    );
    const strip = container.querySelector("[style*='clip-path']") as HTMLElement;
    measure(strip.parentElement!, { left: 100, width: 230 });
    // Four labels now: the trailing one is part of the strip's arithmetic.
    const labels = [...strip.children];
    expect(labels).toHaveLength(4);
    [40, 60, 80, 50].forEach((width, i) => measure(labels[i], { left: 0, width }));

    // The account's wrapper carries the hover, since the button belongs to
    // whoever rendered it (Radix attaches its trigger to the real element).
    const wrapper = screen.getByLabelText("Account").parentElement as HTMLElement;
    measure(wrapper, { left: 300, width: 20 });
    fireEvent.mouseEnter(wrapper);

    expect(insets(strip)).toEqual({ left: ((40 + 60 + 80) / 230) * 100, right: 0 });
    expect(strip.style.opacity).toBe("1");
  });

  it("marks a disabled item and does not fire it", () => {
    const onClick = vi.fn();
    render(<TitlebarDock items={[{ label: "Checking…", icon: <i />, onClick, disabled: true }]} />);
    const button = screen.getByLabelText("Checking…") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});
