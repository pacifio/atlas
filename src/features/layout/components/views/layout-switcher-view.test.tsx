// @vitest-environment happy-dom
//
// The layout switcher's keyboard model: arrows move a selection clamped to the
// grid (Up and Down a row of three), Enter applies it, and every open starts
// on the first tile.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { LAYOUT_TEMPLATES, type LayoutTemplate } from "../../templates";
import { LayoutSwitcherView } from "./layout-switcher-view";

afterEach(cleanup);

// Six tiles (two rows of three), whatever the shipped list holds.
const templates: LayoutTemplate[] = Array.from({ length: 6 }, (_, i) => ({
  ...LAYOUT_TEMPLATES[0],
  id: `t${i}`,
  name: `Template ${i}`,
}));

function setup(open = true) {
  const onApply = vi.fn();
  const onOpenChange = vi.fn();
  const utils = render(
    <LayoutSwitcherView
      open={open}
      onOpenChange={onOpenChange}
      templates={templates}
      onApply={onApply}
    />,
  );
  return { ...utils, onApply, onOpenChange };
}

const dialog = () => screen.getByRole("dialog");
const press = (key: string) => fireEvent.keyDown(dialog(), { key });
const selected = () =>
  screen.getAllByRole("button").findIndex((b) => b.hasAttribute("data-selected"));

describe("LayoutSwitcherView", () => {
  it("applies the next tile on ArrowRight then Enter", () => {
    const { onApply } = setup();
    press("ArrowRight");
    press("Enter");
    expect(onApply).toHaveBeenCalledWith(templates[1]);
  });

  it("moves down a row of three", () => {
    setup();
    press("ArrowDown");
    expect(selected()).toBe(3);
  });

  it("clamps at the first and the last tile", () => {
    setup();
    press("ArrowLeft");
    expect(selected()).toBe(0);
    press("ArrowDown");
    press("ArrowRight");
    press("ArrowRight");
    press("ArrowDown");
    expect(selected()).toBe(5);
  });

  it("starts on the first tile each time it opens", () => {
    const { rerender, onApply, onOpenChange } = setup();
    press("ArrowRight");
    expect(selected()).toBe(1);
    const view = (open: boolean) => (
      <LayoutSwitcherView
        open={open}
        onOpenChange={onOpenChange}
        templates={templates}
        onApply={onApply}
      />
    );
    rerender(view(false));
    rerender(view(true));
    expect(selected()).toBe(0);
  });

  it("applies a tile on click and selects one on hover", () => {
    const { onApply } = setup();
    const tile = screen.getByRole("button", { name: /Template 4/ });
    fireEvent.mouseEnter(tile);
    expect(selected()).toBe(4);
    fireEvent.click(tile);
    expect(onApply).toHaveBeenCalledWith(templates[4]);
  });
});
