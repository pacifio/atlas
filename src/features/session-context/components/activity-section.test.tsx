// @vitest-environment happy-dom
//
// An Activity row opens its panel; as a popover the card closes on the pick,
// since it sits over the panel it opened. Docked, the card stays.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { useSessionSidePanelStore } from "@/features/chat/stores/session-side-panel-store";

import { useSessionDetailsStore } from "../stores/session-details-store";
import { ActivitySection } from "./activity-section";

afterEach(() => {
  cleanup();
  useSessionSidePanelStore.getState().actions.close("t1");
  useSessionDetailsStore.getState().actions.setPopover("s1", false);
});

describe("ActivitySection", () => {
  it("closes the popover card and opens the panel", () => {
    useSessionDetailsStore.getState().actions.setPopover("s1", true);
    render(<ActivitySection tabId="t1" presentation="popover" />);
    fireEvent.click(screen.getByRole("button", { name: "Bash calls" }));
    expect(useSessionDetailsStore.getState().popoverFor).toBeNull();
    expect(useSessionSidePanelStore.getState().open.t1).toBe("bash");
  });

  it("leaves the docked card alone, and a second pick of the open row closes it", () => {
    useSessionDetailsStore.getState().actions.setPopover("s1", true);
    render(<ActivitySection tabId="t1" presentation="docked" />);
    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    expect(useSessionDetailsStore.getState().popoverFor).toBe("s1");
    expect(useSessionSidePanelStore.getState().open.t1).toBe("plans");
    fireEvent.click(screen.getByRole("button", { name: "Plans" }));
    expect(useSessionSidePanelStore.getState().open.t1).toBeUndefined();
  });
});
