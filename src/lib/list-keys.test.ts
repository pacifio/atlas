// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { listKeyTarget, moveOptionFocus } from "./list-keys";

describe("listKeyTarget", () => {
  it("steps without wrapping", () => {
    expect(listKeyTarget("ArrowDown", 0, 3)).toBe(1);
    expect(listKeyTarget("ArrowDown", 2, 3)).toBe(2);
    expect(listKeyTarget("ArrowUp", 0, 3)).toBe(0);
    expect(listKeyTarget("ArrowUp", 2, 3)).toBe(1);
  });

  it("jumps to the ends", () => {
    expect(listKeyTarget("Home", 2, 3)).toBe(0);
    expect(listKeyTarget("End", 0, 3)).toBe(2);
  });

  it("ignores other keys and empty lists", () => {
    expect(listKeyTarget("a", 0, 3)).toBeNull();
    expect(listKeyTarget("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("moveOptionFocus", () => {
  it("moves focus to the next option", () => {
    const list = document.createElement("div");
    list.innerHTML =
      '<div role="option" tabindex="0">a</div><div role="option" tabindex="-1">b<button>x</button></div>';
    document.body.append(list);
    const [a, b] = Array.from(list.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(moveOptionFocus(list, "ArrowDown", a!)).toBe(true);
    expect(document.activeElement).toBe(b);
    // From a control inside the row, the row itself is the origin.
    expect(moveOptionFocus(list, "ArrowUp", b!.querySelector("button"))).toBe(true);
    expect(document.activeElement).toBe(a);
    expect(moveOptionFocus(list, "Enter", a!)).toBe(false);
    list.remove();
  });
});
