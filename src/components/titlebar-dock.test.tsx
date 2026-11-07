// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TitlebarDock, type DockItem } from "./titlebar-dock";
import {
  isTooltipWarm,
  resetTooltipTiming,
  TOOLTIP_OPEN_DELAY,
  TOOLTIP_WARM_WINDOW,
} from "@tryatlas/design";

const tooltip = () => document.querySelector<HTMLElement>("[data-slot='hint-group-tooltip']");
const strip = () => tooltip()?.firstElementChild as HTMLElement;

const items: DockItem[] = [
  { label: "Check for updates", icon: <i />, onClick: vi.fn() },
  { label: "Notifications", icon: <i />, onClick: vi.fn() },
  { label: "Hide right panel", icon: <i />, onClick: vi.fn() },
];

/**
 * happy-dom has no layout. Measure controls and lazily mounted labels with
 * distinct widths so a wrong offset cannot cancel itself out. The strip's
 * rect includes its current translation, so measuring it as the origin would
 * make successive hovers drift.
 */
function layout(container: HTMLElement, iconCentres = [120, 200, 280], widths = [40, 60, 80]) {
  const buttons = [...container.querySelectorAll("button")];
  const targets = buttons.map((button) => button.closest(".inline-flex") as HTMLElement);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const index = targets.indexOf(this);
    if (index !== -1) return new DOMRect(iconCentres[index] - 12, 10, 24, 24);
    if (this === strip()) {
      return new DOMRect(
        translateX(),
        40,
        widths.reduce((sum, width) => sum + width, 0),
        22,
      );
    }
    if (this.matches("[data-slot='hint-group-tooltip'] > div > div")) {
      const labelIndex = [...this.parentElement!.children].indexOf(this);
      return new DOMRect(0, 0, widths[labelIndex], 22);
    }
    return new DOMRect();
  });
  return { buttons, targets };
}

const translateX = () => Number(/translateX\(([-\d.]+)px\)/.exec(strip().style.transform)![1]);
const insets = () => {
  const m = /inset\(0 ([\d.]+)% 0 ([\d.]+)%/.exec(strip().style.clipPath)!;
  return { right: Number(m[1]), left: Number(m[2]) };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetTooltipTiming();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Hover and wait out the shared open delay. */
function hover(el: Element) {
  fireEvent.mouseEnter(el);
  act(() => vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY));
}

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

  it("mounts no tooltip until the dock is used", () => {
    render(<TitlebarDock items={items} />);
    expect(tooltip()).toBeNull();
  });

  it("clips away every label but the hovered one", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);

    hover(targets[1]);
    // 40 of 180 to the left, 80 of 180 to the right.
    expect(insets()).toEqual({ left: (40 / 180) * 100, right: (80 / 180) * 100 });
    expect(strip().style.opacity).toBe("1");
  });

  it("shows the first label with nothing clipped on its left", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    hover(targets[0]);
    expect(insets()).toEqual({ left: 0, right: ((60 + 80) / 180) * 100 });
  });

  it("centres successive labels without accumulating offsets", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);

    hover(targets[1]);
    // The fixed strip starts at viewport x=0; the second label starts at 40.
    expect(translateX() + 40 + 30).toBe(200);
    fireEvent.mouseEnter(targets[2]);
    expect(translateX() + 40 + 60 + 40).toBe(280);
    fireEvent.mouseEnter(targets[0]);
    expect(translateX() + 20).toBe(120);
  });

  it("pulls the tooltip back inside the window at the right edge", () => {
    const { container } = render(<TitlebarDock items={items} />);
    // Last icon near the edge: its 80px label would otherwise overhang.
    const { targets } = layout(container, [120, 200, window.innerWidth - 10]);

    hover(targets[2]);
    const centre = window.innerWidth - 10;
    const unclamped = centre - (40 + 60 + 40);
    const overflow = centre + 40 - (window.innerWidth - 8);
    expect(translateX()).toBe(unclamped - overflow);
    // Which is to say: its right edge lands exactly on the margin.
    expect(100 + translateX() + 80).toBe(window.innerWidth - 8);
  });

  it("materialises in place on first hover, then animates between items", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);

    hover(targets[0]);
    // Nothing to travel from yet — a transform transition here would fly the
    // tooltip in from the origin.
    expect(strip().style.transition).not.toContain("transform");

    hover(targets[1]);
    expect(strip().style.transition).toContain("transform");
    expect(strip().style.transition).toContain("clip-path");
  });

  it("fades out without moving after the leave grace", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    hover(targets[1]);
    const held = strip().style.transform;

    fireEvent.mouseLeave(targets[1]);
    act(() => vi.advanceTimersByTime(79));
    expect(strip().style.opacity).toBe("1");
    act(() => vi.advanceTimersByTime(1));
    expect(strip().style.opacity).toBe("0");
    expect(strip().style.transform).toBe(held);
  });

  it("stays silent when nothing can be measured", () => {
    // The zero-rect case: a hidden titlebar, or a hover before layout. Better
    // to show no tooltip than one stacked at the origin.
    render(<TitlebarDock items={items} />);
    hover(screen.getAllByRole("button")[1]);
    expect(strip().style.opacity).toBe("0");
  });

  it("hosts a trailing control with its own tooltip and action", () => {
    const onClick = vi.fn();
    const { container } = render(
      <TitlebarDock
        items={items}
        trailing={{
          label: "Account",
          node: <button aria-label="Your account" onClick={onClick} />,
        }}
      />,
    );
    const { buttons, targets } = layout(container, [120, 200, 280, 310], [40, 60, 80, 50]);
    hover(targets[3]);
    expect(strip().children).toHaveLength(4);
    expect(insets()).toEqual({ left: ((40 + 60 + 80) / 230) * 100, right: 0 });
    expect(strip().style.opacity).toBe("1");
    expect(translateX() + 180 + 25).toBe(310);
    fireEvent.click(buttons[3]);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Your account" })).toBe(buttons[3]);
  });

  it("shows help for a disabled item without firing its action", () => {
    const onClick = vi.fn();
    const { container } = render(
      <TitlebarDock items={[{ label: "Checking…", icon: <i />, onClick, disabled: true }]} />,
    );
    const { buttons, targets } = layout(container, [120], [60]);
    expect(buttons[0].disabled).toBe(true);
    hover(targets[0]);
    expect(strip().style.opacity).toBe("1");
    expect(strip().textContent).toBe("Checking…");
    fireEvent.click(buttons[0]);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("waits for the open delay before the first label", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    fireEvent.mouseEnter(targets[0]);
    expect(strip().style.opacity).toBe("0");
    act(() => vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY - 1));
    expect(strip().style.opacity).toBe("0");
    act(() => vi.advanceTimersByTime(1));
    expect(strip().style.opacity).toBe("1");
  });

  it("does not open if the pointer leaves during the delay", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    fireEvent.mouseEnter(targets[0]);
    fireEvent.mouseLeave(targets[0]);
    act(() => vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY * 2));
    expect(tooltip()).toBeNull();
    expect(isTooltipWarm()).toBe(false);
  });

  it("opens instantly right after a tooltip closed, then waits again once cold", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    hover(targets[0]);
    fireEvent.mouseLeave(targets[0]);
    act(() => vi.advanceTimersByTime(80));

    fireEvent.mouseEnter(targets[1]);
    expect(strip().style.opacity).toBe("1");
    fireEvent.mouseLeave(targets[1]);
    act(() => vi.advanceTimersByTime(80));

    act(() => vi.advanceTimersByTime(TOOLTIP_WARM_WINDOW + 1));
    fireEvent.mouseEnter(targets[2]);
    expect(strip().style.opacity).toBe("0");
  });

  it("slides without overshoot", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    hover(targets[0]);
    fireEvent.mouseEnter(targets[1]);
    expect(strip().style.transition).toContain("cubic-bezier(0.23, 1, 0.32, 1)");
    expect(strip().style.transition).not.toMatch(/1\.2, 0\.36/);
  });

  it("preserves the accessible name, pressed state and badge", () => {
    const { container } = render(
      <TitlebarDock
        className="ml-2"
        items={[
          { ...items[1], title: "Notifications: 2 unread", pressed: true, badge: <span>2</span> },
        ]}
      />,
    );
    const button = screen.getByRole("button", { name: "Notifications: 2 unread" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.textContent).toBe("2");
    expect(container.firstElementChild?.classList.contains("ml-2")).toBe(true);
    const { targets } = layout(container, [120], [60]);
    hover(targets[0]);
    expect(strip().textContent).toBe("Notifications");
  });

  it("keeps the strip visible while crossing a gap between controls", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    hover(targets[0]);
    const originalStrip = strip();
    fireEvent.mouseLeave(targets[0]);
    act(() => vi.advanceTimersByTime(40));
    fireEvent.mouseEnter(targets[1]);
    act(() => vi.advanceTimersByTime(40));
    expect(strip()).toBe(originalStrip);
    expect(strip().style.opacity).toBe("1");
    expect(translateX() + 40 + 30).toBe(200);
  });

  it.each([false, true])("shows help on keyboard focus (trailing: %s)", (trailing) => {
    const { container } = render(
      <TitlebarDock
        items={items}
        trailing={
          trailing ? { label: "Account", node: <button aria-label="Account" /> } : undefined
        }
      />,
    );
    const { buttons } = layout(container, [120, 200, 280, 310], [40, 60, 80, 50]);
    const button = buttons[trailing ? 3 : 0];
    vi.spyOn(button, "matches").mockImplementation((selector) => selector === ":focus-visible");
    fireEvent.focus(button);
    act(() => vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY));
    expect(strip().style.opacity).toBe("1");
    expect(insets().left === 0).toBe(!trailing);
    fireEvent.blur(button);
    act(() => vi.advanceTimersByTime(80));
    expect(strip().style.opacity).toBe("0");
  });

  it.each(["Escape", "pointer down", "scroll"])("dismisses on %s", (action) => {
    const { container } = render(<TitlebarDock items={items} />);
    const { buttons, targets } = layout(container);
    hover(targets[0]);
    if (action === "Escape") fireEvent.keyDown(buttons[0], { key: "Escape" });
    else if (action === "pointer down") fireEvent.pointerDown(buttons[0]);
    else fireEvent.scroll(container);
    expect(strip().style.opacity).toBe("0");
  });

  it.each([false, true])("cleans up when an item disappears (already open: %s)", (open) => {
    const { container, rerender } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    fireEvent.mouseEnter(targets[0]);
    if (open) act(() => vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY));
    rerender(<TitlebarDock items={items.slice(1)} />);
    act(() => vi.advanceTimersByTime(1000));
    expect(isTooltipWarm()).toBe(false);
    expect(strip()?.style.opacity ?? "0").toBe("0");
  });

  it("cleans up the portal and shared timing when the dock unmounts", () => {
    const { container, unmount } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    hover(targets[0]);
    unmount();
    act(() => vi.advanceTimersByTime(TOOLTIP_WARM_WINDOW + 1));
    expect(tooltip()).toBeNull();
    expect(isTooltipWarm()).toBe(false);
  });
});

describe("the dock's sliding label strip", () => {
  /**
   * The strip holds every label at full layout width; clip-path only changes
   * its paint. When it was absolute inside the titlebar, that width created
   * scrollable overflow in #root. Focusing a control could then scroll the
   * entire shell sideways. A fixed portal outside the shell avoids that.
   */
  it("is portalled outside the dock and fixed below the hovered control", () => {
    const { container } = render(<TitlebarDock items={items} />);
    const { targets } = layout(container);
    hover(targets[0]);
    const anchor = tooltip()!;
    expect(anchor.parentElement).toBe(document.body);
    expect(container.contains(anchor)).toBe(false);
    expect(anchor.classList.contains("fixed")).toBe(true);
    expect(anchor.classList.contains("absolute")).toBe(false);
    expect(anchor.classList.contains("z-tooltip")).toBe(true);
    expect(anchor.style.top).toBe("40px");
    expect(anchor.style.bottom).toBe("");
  });
});
