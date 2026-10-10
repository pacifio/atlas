// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TitlebarDock } from "@/components/titlebar-dock";
import { HintGroup, HintItem } from "./hint-group";
import { Hint } from "./tooltip";
import { Button } from "./button";
import { resetTooltipTiming, TOOLTIP_OPEN_DELAY } from "./tooltip-timing";

const help = "File Explorer — Browse project files";

beforeEach(() => {
  vi.useFakeTimers();
  resetTooltipTiming();
  // Sliding hints need layout; happy-dom does not measure boxes.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 100,
    y: 100,
    left: 100,
    top: 100,
    right: 300,
    bottom: 124,
    width: 200,
    height: 24,
    toJSON() {},
  });
  const matches = HTMLElement.prototype.matches;
  vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(
    function (this: HTMLElement, selector) {
      return selector === ":focus-visible" || matches.call(this, selector);
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetTooltipTiming();
});

function pointerPath(el: Element) {
  const path: Element[] = [];
  for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
    path.push(node);
  }
  return path;
}

// mouseenter/leave do not bubble. A browser emits them for each entered/left
// ancestor too, including Base UI's positioner around the tooltip popup.
function point(el: Element) {
  fireEvent.pointerEnter(el, { pointerType: "mouse" });
  pointerPath(el)
    .reverse()
    .forEach((node) => fireEvent.mouseEnter(node));
  act(() => vi.advanceTimersByTime(0));
}

function leave(el: Element) {
  fireEvent.pointerLeave(el, { pointerType: "mouse" });
  pointerPath(el).forEach((node) => fireEvent.mouseLeave(node, { relatedTarget: document.body }));
}

function fixture(kind: "single" | "group" | "dock") {
  const button = <button aria-label="File Explorer">Files</button>;
  render(
    kind === "single" ? (
      <Hint label={help}>{button}</Hint>
    ) : kind === "group" ? (
      <HintGroup>
        <HintItem label={help}>{button}</HintItem>
      </HintGroup>
    ) : (
      <TitlebarDock
        items={[{ label: help, title: "File Explorer", icon: <i />, onClick: vi.fn() }]}
      />
    ),
  );
  const trigger = screen.getByRole("button", { name: "File Explorer" });
  return { trigger };
}

describe.each(["single", "group", "dock"] as const)("%s navigation hint", (kind) => {
  it("shows keyboard help immediately and describes the focused control", () => {
    const { trigger } = fixture(kind);
    act(() => trigger.focus());
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe(help);
    expect(trigger.getAttribute("aria-describedby")?.split(" ")).toContain(tooltip.id);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("waits on hover, and Escape dismisses it even when focus is elsewhere", () => {
    const { trigger } = fixture(kind);
    point(trigger);
    act(() => vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY - 1));
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("tooltip").textContent).toBe(help);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("allows a short pointer gap and keeps the tooltip open while it is hovered", () => {
    const { trigger } = fixture(kind);
    point(trigger);
    act(() => vi.advanceTimersByTime(TOOLTIP_OPEN_DELAY));
    const tooltip = screen.getByRole("tooltip");
    leave(trigger);
    act(() => vi.advanceTimersByTime(40));
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    point(tooltip);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("tooltip")).toBe(tooltip);
    leave(tooltip);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("cancels a pending hover when the pointer leaves before the delay", () => {
    const { trigger } = fixture(kind);
    point(trigger);
    leave(trigger);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("closes keyboard help on blur without waiting for the pointer grace", () => {
    const { trigger } = fixture(kind);
    act(() => trigger.focus());
    expect(screen.getByRole("tooltip")).toBeTruthy();
    act(() => trigger.blur());
    act(() => vi.advanceTimersByTime(0));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

it("describes a wrapped, focusable disabled button and retains existing help", () => {
  const onClick = vi.fn();
  render(
    <>
      <p id="existing-help">Project tools</p>
      <Hint label="Open a project to open its knowledge base">
        <Button disabled focusableWhenDisabled aria-describedby="existing-help" onClick={onClick}>
          Knowledge
        </Button>
      </Hint>
    </>,
  );
  const trigger = screen.getByRole("button");
  act(() => trigger.focus());
  const tooltip = screen.getByRole("tooltip");
  expect(trigger.getAttribute("aria-describedby")?.split(" ")).toEqual([
    "existing-help",
    tooltip.id,
  ]);
  expect(trigger.getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(trigger);
  expect(onClick).not.toHaveBeenCalled();
});

it("shows the dock's hosted account help on keyboard focus", () => {
  render(
    <TitlebarDock
      items={[]}
      trailing={{ label: "Account and settings", node: <button>Account</button> }}
    />,
  );
  const trigger = screen.getByRole("button");
  act(() => trigger.focus());
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.textContent).toBe("Account and settings");
  expect(trigger.getAttribute("aria-describedby")).toBe(tooltip.id);
});
