// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginDragOnMove, isWindowSurface } from "./titlebar-chrome";

afterEach(() => {
  document.body.innerHTML = "";
});

function el(html: string, selector: string): HTMLElement {
  document.body.innerHTML = html;
  return document.querySelector<HTMLElement>(selector)!;
}

describe("isWindowSurface", () => {
  it("is true for the bar itself", () => {
    expect(isWindowSurface(el("<div id='bar'></div>", "#bar"))).toBe(true);
  });

  it("is false for a button and for anything inside one", () => {
    expect(isWindowSurface(el("<button id='b'></button>", "#b"))).toBe(false);
    expect(isWindowSurface(el("<button><span id='s'>x</span></button>", "#s"))).toBe(false);
  });

  it("is false for a tab, a menu item and an opted-out element", () => {
    expect(isWindowSurface(el("<div role='tab'><span id='s'></span></div>", "#s"))).toBe(false);
    expect(isWindowSurface(el("<div role='menuitem' id='m'></div>", "#m"))).toBe(false);
    expect(isWindowSurface(el("<div data-no-window-drag><i id='i'></i></div>", "#i"))).toBe(false);
  });

  it("is true for no target", () => {
    expect(isWindowSurface(null)).toBe(true);
  });
});

describe("beginDragOnMove", () => {
  const move = (x: number, y: number) =>
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));

  it("does not start within the threshold", () => {
    const start = vi.fn();
    beginDragOnMove({ clientX: 10, clientY: 10 }, start);
    move(13, 10);
    expect(start).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("mouseup"));
  });

  it("starts once past it, and only once", () => {
    const start = vi.fn();
    beginDragOnMove({ clientX: 10, clientY: 10 }, start);
    move(15, 10);
    move(30, 10);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the button comes up", () => {
    const start = vi.fn();
    beginDragOnMove({ clientX: 10, clientY: 10 }, start);
    window.dispatchEvent(new MouseEvent("mouseup"));
    move(50, 50);
    expect(start).not.toHaveBeenCalled();
  });
});
