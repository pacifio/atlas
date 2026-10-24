// @vitest-environment happy-dom
//
// The Details button: a steady capture dot (visible without opening
// anything, never animated), a toggle for the docked card where the chat
// panel keeps room for it, and the card as a popover anywhere else.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const invoke = vi.hoisted(() => vi.fn(async (_cmd: string, _args?: unknown) => null as unknown));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { createRef } from "react";
import { resetProjectFactsCache } from "@/features/capture/lib/project-facts";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useSessionDetailsStore } from "../stores/session-details-store";
import { SessionDetailsButton } from "./session-details-button";

const PATH = "/work/acme";
const TAB = "tab-1";
const SCOPE = `t:${TAB}`;

function answer(enabled: boolean | null) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "capture_binding")
      return enabled === null
        ? null
        : { workspaceId: "p1", root: PATH, mode: "local", slug: null, enabled };
    if (cmd === "capture_health")
      return { state: enabled ? "ok" : "off", summary: "Capturing", issues: [] };
    return null;
  });
}

const dot = () => document.querySelector("[data-capture-dot]");
const button = () => screen.getByRole("button", { name: /^Session details/ });

beforeEach(() => {
  resetProjectFactsCache();
  useProjectStore.setState({
    projects: [{ id: "p1", path: PATH, name: "acme" }],
    activeProjectId: "p1",
  } as never);
  useSessionDetailsStore.setState({
    open: {},
    popoverFor: null,
    dockable: {},
    view: "main",
    instant: false,
  });
});
afterEach(() => cleanup());

async function mount(docked = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SessionDetailsButton
        tabId={TAB}
        scope={SCOPE}
        docked={docked}
        stageRef={createRef<HTMLElement>()}
        onOpenSearch={() => {}}
      />
    </QueryClientProvider>,
  );
  // Let the binding and health reads land.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("SessionDetailsButton", () => {
  it("is named Session details, with its own glyph", async () => {
    answer(null);
    await mount();
    expect(button()).toBeTruthy();
    // Not the panel glyph the right panel toggle uses.
    expect(button().querySelector(".lucide-panel-right")).toBeNull();
    expect(button().querySelector(".lucide-square-menu")).not.toBeNull();
  });

  it("shows a steady dot while capture records", async () => {
    answer(true);
    await mount();
    const el = dot();
    expect(el).not.toBeNull();
    expect(el?.innerHTML ?? "").not.toMatch(/animate-|pulse|ping/);
  });

  it("shows no dot when capture is paused or was never set up", async () => {
    answer(false);
    await mount();
    expect(dot()).toBeNull();
    cleanup();
    resetProjectFactsCache();
    answer(null);
    await mount();
    expect(dot()).toBeNull();
  });

  it("opens the card as a popover where the panel cannot dock it", async () => {
    answer(true);
    await mount(false);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(useSessionDetailsStore.getState().popoverFor).toBe(SCOPE);
    expect(useSessionDetailsStore.getState().open).toEqual({});
    // The card is lazy: its first import can outlast the default wait under a full run.
    expect(
      await screen.findByRole("region", { name: "Session details" }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(await screen.findByText("Capture", undefined, { timeout: 5000 })).toBeTruthy();
  });

  it("is a toggle for the docked card where the chat panel can dock it", async () => {
    answer(false);
    await mount(true);
    expect(button().getAttribute("aria-pressed")).toBe("false");
    await act(async () => fireEvent.click(button()));
    expect(useSessionDetailsStore.getState().open[SCOPE]).toBe(true);
    // The card is the panel's, not a popover: nothing opened here.
    expect(useSessionDetailsStore.getState().popoverFor).toBeNull();
    expect(button().getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.click(button()));
    expect(useSessionDetailsStore.getState().open[SCOPE]).toBeUndefined();
  });

  it("hands an open popover over to the docked card when room appears", async () => {
    answer(false);
    useSessionDetailsStore.setState({ popoverFor: SCOPE });
    await mount(true);
    expect(useSessionDetailsStore.getState().popoverFor).toBeNull();
    expect(useSessionDetailsStore.getState().open[SCOPE]).toBe(true);
  });
});
