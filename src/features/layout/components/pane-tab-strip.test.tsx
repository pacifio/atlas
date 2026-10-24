// @vitest-environment happy-dom
/**
 * The surfaces pane's tab strip (`PaneTabStrip`).
 *
 * - A press on a tab is a click until the pointer travels the activation
 *   distance: selecting a tab never starts a drag, and never reorders.
 * - Past that distance the press is a drag of that tab.
 * - When the tabs do not fit, the active tab is scrolled into view, clear of
 *   the edge fade, and the scroll arrows appear.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

import type { Tab } from "../stores/layout-store";
import {
  PaneTabStrip,
  TAB_DRAG_ACTIVATION_DISTANCE,
  TAB_STRIP_FADE_PX,
  scrollLeftToReveal,
} from "./pane-tab-strip";

const tab = (id: string): Tab => ({
  id,
  type: "terminal",
  title: id,
  closable: true,
  dirty: false,
  data: {},
  groupId: "g2",
});

const TABS = ["a", "b", "c", "d", "e", "f"].map(tab);
const NONE = new Set<string>();

function strip(props: Partial<Parameters<typeof PaneTabStrip>[0]> = {}) {
  const onSelect = vi.fn();
  const onMove = vi.fn();
  const view = render(
    <PaneTabStrip
      tabs={TABS}
      activeId="a"
      focused
      runningTabIds={NONE}
      onSelect={onSelect}
      onMove={onMove}
      {...props}
    />,
  );
  return { ...view, onSelect, onMove };
}

const tabEl = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)!;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a click is never a drag", () => {
  it("selects the tab on a press that moves less than the activation distance", () => {
    const { container, onSelect, onMove } = strip();
    const b = tabEl(container, "b");
    fireEvent.pointerDown(b, { button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, {
      clientX: 10 + TAB_DRAG_ACTIVATION_DISTANCE - 2,
      clientY: 10,
    });
    fireEvent.pointerUp(document, { clientX: 10 + TAB_DRAG_ACTIVATION_DISTANCE - 2, clientY: 10 });
    fireEvent.click(b);
    expect(onSelect).toHaveBeenCalledWith("b");
    expect(onMove).not.toHaveBeenCalled();
    // Never lifted into the dragging state.
    expect(b.className).not.toContain("z-10");
  });

  it("lifts the tab once the pointer travels past the activation distance", () => {
    const { container } = strip();
    const b = tabEl(container, "b");
    act(() => {
      fireEvent.pointerDown(b, { button: 0, isPrimary: true, clientX: 10, clientY: 10 });
    });
    act(() => {
      fireEvent.pointerMove(document, {
        clientX: 10 + TAB_DRAG_ACTIVATION_DISTANCE * 4,
        clientY: 10,
      });
    });
    expect(tabEl(container, "b").className).toContain("z-10");
    act(() => {
      fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
      fireEvent.pointerUp(document);
    });
  });

  it("never lifts a tab on a middle-button press, nor selects it", () => {
    const { container, onSelect } = strip();
    const b = tabEl(container, "b");
    fireEvent.pointerDown(b, { button: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(document, { clientX: 60, clientY: 10 });
    expect(b.className).not.toContain("z-10");
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("overflow", () => {
  it("reveals a tab off either end, clear of the fade, moving as little as possible", () => {
    // Viewport 0..200 of a 600px row.
    expect(scrollLeftToReveal(0, 200, 300, 380)).toBe(380 + TAB_STRIP_FADE_PX - 200);
    expect(scrollLeftToReveal(300, 200, 100, 180)).toBe(100 - TAB_STRIP_FADE_PX);
    expect(scrollLeftToReveal(100, 200, 150, 220)).toBe(100);
    expect(scrollLeftToReveal(10, 200, 5, 60)).toBe(0);
  });

  it("scrolls the active tab into view and shows the arrows when the tabs do not fit", () => {
    const TAB_W = 80;
    const VIEW_W = 200;
    // Each tab is laid out at its index; the viewport is 200px of a 480px row.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const id = this.dataset.tabId;
        const scroller = this.closest<HTMLElement>("[data-pane-tab-strip]");
        const scrolled = scroller?.scrollLeft ?? 0;
        const left = id ? TABS.findIndex((t) => t.id === id) * TAB_W - scrolled : 0;
        const width = id ? TAB_W : VIEW_W;
        return {
          left,
          right: left + width,
          width,
          top: 0,
          bottom: 24,
          height: 24,
          x: left,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-pane-tab-strip") ? TABS.length * TAB_W : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.hasAttribute("data-pane-tab-strip") ? VIEW_W : 0;
      },
    );

    const { container, rerender, getByLabelText } = strip({ activeId: "a" });
    const viewport = container.querySelector<HTMLElement>("[data-pane-tab-strip]")!;
    expect(getByLabelText("Scroll tabs right")).toBeTruthy();
    expect(viewport.scrollLeft).toBe(0);

    // The last tab becomes active (opened off the end, or picked with ⌘6).
    rerender(
      <PaneTabStrip
        tabs={TABS}
        activeId="f"
        focused
        runningTabIds={NONE}
        onSelect={vi.fn()}
        onMove={vi.fn()}
      />,
    );
    const fEnd = TABS.length * TAB_W;
    expect(viewport.scrollLeft).toBe(fEnd + TAB_STRIP_FADE_PX - VIEW_W);
    const start = 5 * TAB_W - viewport.scrollLeft;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start + TAB_W).toBeLessThanOrEqual(VIEW_W);
  });

  it("shows no arrows when every tab fits", () => {
    const { queryByLabelText } = strip({ tabs: TABS.slice(0, 2) });
    expect(queryByLabelText("Scroll tabs left")).toBeNull();
    expect(queryByLabelText("Scroll tabs right")).toBeNull();
  });
});
