// @vitest-environment happy-dom
//
// The Details button: a toggle for the docked card where the chat panel keeps
// room for it, the card as a popover anywhere else, and ⌘⌥B doing the same
// for the session on screen only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("./session-details-card", () => ({
  SessionDetailsCard: () => <div role="region" aria-label="Session details" />,
}));

import { createRef } from "react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { toggleSessionDetails } from "../lib/details-commands";
import { useSessionDetailsStore } from "../stores/session-details-store";
import { SessionDetailsButton } from "./session-details-button";

const TAB = "tab-1";
const SCOPE = `t:${TAB}`;

const button = () => screen.getByRole("button", { name: /^Session details/ });

beforeEach(() => {
  useSessionDetailsStore.setState({ hidden: {}, popoverFor: null, instant: false });
  useLayoutStore.setState({ activeTabId: TAB });
});
afterEach(() => cleanup());

function mount(docked = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionDetailsButton
        tabId={TAB}
        scope={SCOPE}
        docked={docked}
        stageRef={createRef<HTMLElement>()}
      />
    </QueryClientProvider>,
  );
}

describe("SessionDetailsButton", () => {
  it("is named Session details, with its own glyph", () => {
    mount();
    // Not the panel glyph the right panel toggle uses.
    expect(button().querySelector(".lucide-panel-right")).toBeNull();
    expect(button().querySelector(".lucide-square-dashed-mouse-pointer")).not.toBeNull();
  });

  it("opens the card as a popover where the panel cannot dock it", async () => {
    mount(false);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(useSessionDetailsStore.getState().popoverFor).toBe(SCOPE);
    expect(useSessionDetailsStore.getState().hidden).toEqual({});
    expect(
      await screen.findByRole("region", { name: "Session details" }, { timeout: 5000 }),
    ).toBeTruthy();
  });

  it("is a toggle for the docked card where the chat panel can dock it", async () => {
    mount(true);
    // Shown by default where it docks.
    expect(button().getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(button()));
    expect(useSessionDetailsStore.getState().hidden[SCOPE]).toBe(true);
    // The card is the panel's, not a popover: nothing opened here.
    expect(useSessionDetailsStore.getState().popoverFor).toBeNull();
    expect(button().getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(button()));
    expect(useSessionDetailsStore.getState().hidden[SCOPE]).toBeUndefined();
  });

  it("answers the shortcut, in either form, without an entrance", () => {
    mount(true);
    act(() => toggleSessionDetails());
    expect(useSessionDetailsStore.getState().hidden[SCOPE]).toBe(true);
    expect(useSessionDetailsStore.getState().instant).toBe(true);
    cleanup();
    mount(false);
    act(() => toggleSessionDetails());
    expect(useSessionDetailsStore.getState().popoverFor).toBe(SCOPE);
    act(() => toggleSessionDetails());
    expect(useSessionDetailsStore.getState().popoverFor).toBeNull();
  });

  it("leaves the shortcut to the session on screen", () => {
    useLayoutStore.setState({ activeTabId: "another-tab" });
    mount(true);
    act(() => toggleSessionDetails());
    expect(useSessionDetailsStore.getState().hidden).toEqual({});
  });
});
