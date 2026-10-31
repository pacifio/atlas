// @vitest-environment happy-dom
//
// The window group's panel toggle: always there while a project is open,
// pressed while the surfaces pane is on screen, and the pane's one show/hide
// control.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { HintGroup } from "@/ui/hint-group";
import { useLayoutStore } from "../stores/layout-store";
import { RightPanelToggle } from "./right-panel-toggle";

const layout = () => useLayoutStore.getState();
const toggle = () => screen.getByRole("button", { name: /panel$/ });

beforeEach(() => {
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
  render(
    <HintGroup>
      <RightPanelToggle />
    </HintGroup>,
  );
});
afterEach(cleanup);

describe("RightPanelToggle", () => {
  it("opens a pane when there is none, and is pressed while it shows", () => {
    expect(layout().groupOrder).toHaveLength(1);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe("Show panel");
    act(() => fireEvent.click(toggle()));
    expect(layout().groupOrder).toHaveLength(2);
    expect(layout().surfaces).toBe("shown");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe("Hide panel");
  });

  it("hides and shows the pane, which keeps its tabs", () => {
    act(() => fireEvent.click(toggle()));
    const columns = layout().groupOrder.length;
    act(() => fireEvent.click(toggle()));
    expect(layout().surfaces).toBe("hidden");
    expect(layout().groupOrder).toHaveLength(columns);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    act(() => fireEvent.click(toggle()));
    expect(layout().surfaces).toBe("shown");
  });

  it("follows the pane when its own controls change it", () => {
    act(() => fireEvent.click(toggle()));
    act(() => layout().actions.setSurfaces("expanded"));
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().querySelector(".lucide-panel-right")).not.toBeNull();
  });

  it("over a destination, goes back to the session with the pane on screen", () => {
    act(() => fireEvent.click(toggle()));
    act(() =>
      layout().actions.addTab({
        id: "artifacts",
        type: "artifacts",
        title: "Timeline",
        closable: true,
        dirty: false,
        data: {},
      }),
    );
    expect(layout().destinationShown).toBe(true);
    act(() => fireEvent.click(toggle()));
    expect(layout().destinationShown).toBe(false);
    expect(layout().surfaces).toBe("shown");
  });
});
