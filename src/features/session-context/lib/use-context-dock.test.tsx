// @vitest-environment happy-dom
//
// The docked Details card's room: reserved from the panel's width alone, so
// the transcript row, the column centred in it and the composer stack are laid
// out the same whether or not the card shows. This mounts the real hook the
// way `chat-panel.tsx` wires it.

import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
import { resolveContextDock } from "./context-dock";
import { useSessionDetailsStore } from "../stores/session-details-store";
import { useContextDock } from "./use-context-dock";

let panelWidth = 1000;

/** `chat-panel.tsx`'s wiring: the row's padding and the composer's margin,
 *  both from one `useContextDock`. */
function Panel({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const dock = useContextDock(ref, enabled);
  return (
    <div ref={ref} data-panel data-docked={String(dock.docked)}>
      <div
        data-chat-row
        style={dock.docked ? { paddingLeft: dock.inset, paddingRight: dock.reserve } : undefined}
      >
        <div data-chat-column />
      </div>
      <div
        data-composer
        style={dock.docked ? { marginLeft: dock.inset, marginRight: dock.reserve } : undefined}
      />
    </div>
  );
}

const docked = () => document.querySelector("[data-panel]")!.getAttribute("data-docked");

/** Everything the column's position and width are computed from. */
function layout() {
  const box = (sel: string) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    return { style: el.getAttribute("style"), className: el.className };
  };
  return {
    row: box("[data-chat-row]"),
    column: box("[data-chat-column]"),
    composer: box("[data-composer]"),
  };
}

beforeEach(() => {
  panelWidth = 1000;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-panel") ? panelWidth : 0;
  });
  useSessionDetailsStore.setState({ hidden: {}, popoverFor: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the Details card's dock", () => {
  it("reserves its room from the width, and opening the card moves nothing", () => {
    render(<Panel />);
    const { reserve } = resolveContextDock(1000, Number.POSITIVE_INFINITY);
    expect(reserve).toBeGreaterThan(0);
    expect(docked()).toBe("true");

    const closed = layout();
    expect(closed.row.style).toContain(`padding-right: ${reserve}px`);
    expect(closed.composer.style).toContain(`margin-right: ${reserve}px`);

    act(() => useSessionDetailsStore.getState().actions.toggle("t:tab-1"));
    expect(layout()).toEqual(closed);
  });

  it("does not dock, or reserve, where the panel is too narrow", () => {
    panelWidth = 700;
    render(<Panel />);
    expect(docked()).toBe("false");
    expect(layout().row.style).toBeNull();
  });

  it("reserves nothing while disabled (an empty session has no column to clear)", () => {
    render(<Panel enabled={false} />);
    expect(docked()).toBe("false");
    expect(layout().row.style).toBeNull();
  });
});
