// @vitest-environment happy-dom
import { render, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { TerminalTabStrip } from "./terminal-tab-strip";
import { useTerminalStore, type PaneNode } from "../stores/terminal-store";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TerminalTabStrip", () => {
  it("closes tab on close button click", () => {
    useTerminalStore.setState((s) => {
      s.tabs["tab1"] = {
        root: { id: "p1", type: "pane", terminals: ["t1", "t2"], activeTerminalId: "t1" },
        activePaneId: "p1",
        zoomedPaneId: null,
      };
      return s;
    });

    const pane: PaneNode = {
      id: "p1",
      type: "pane",
      terminals: ["t1", "t2"],
      activeTerminalId: "t1",
    };

    const { getAllByRole } = render(
      <TerminalTabStrip pane={pane} tabId="tab1" hasSplits={false} />,
    );

    const closeButtons = getAllByRole("button", { name: "Close terminal" });
    expect(closeButtons.length).toBe(2);

    fireEvent.click(closeButtons[0]);

    const tabState = useTerminalStore.getState().tabs["tab1"];
    expect((tabState.root as PaneNode).terminals).toEqual(["t2"]);
  });

  it("prevents default on left-button mousedown on close button to stop native drag", () => {
    const pane: PaneNode = {
      id: "p1",
      type: "pane",
      terminals: ["t1", "t2"],
      activeTerminalId: "t1",
    };

    const { getAllByRole } = render(
      <TerminalTabStrip pane={pane} tabId="tab1" hasSplits={false} />,
    );

    const closeButtons = getAllByRole("button", { name: "Close terminal" });
    const event = new MouseEvent("mousedown", { button: 0, cancelable: true, bubbles: true });
    closeButtons[0].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("closes tab on middle-click (auxclick with button 1)", () => {
    useTerminalStore.setState((s) => {
      s.tabs["tab1"] = {
        root: { id: "p1", type: "pane", terminals: ["t1", "t2"], activeTerminalId: "t1" },
        activePaneId: "p1",
        zoomedPaneId: null,
      };
      return s;
    });

    const pane: PaneNode = {
      id: "p1",
      type: "pane",
      terminals: ["t1", "t2"],
      activeTerminalId: "t1",
    };

    const { getAllByRole } = render(
      <TerminalTabStrip pane={pane} tabId="tab1" hasSplits={false} />,
    );

    const tabs = getAllByRole("tab");
    expect(tabs.length).toBe(2);

    fireEvent.mouseDown(tabs[0], { button: 1 });
    fireEvent(tabs[0], new MouseEvent("auxclick", { button: 1, bubbles: true }));

    const tabState = useTerminalStore.getState().tabs["tab1"];
    expect((tabState.root as PaneNode).terminals).toEqual(["t2"]);
  });

  it("does not close on middle-click if not closable", () => {
    useTerminalStore.setState((s) => {
      s.tabs["tab1"] = {
        root: { id: "p1", type: "pane", terminals: ["t1"], activeTerminalId: "t1" },
        activePaneId: "p1",
        zoomedPaneId: null,
      };
      return s;
    });

    const pane: PaneNode = {
      id: "p1",
      type: "pane",
      terminals: ["t1"],
      activeTerminalId: "t1",
    };

    const { getByRole } = render(<TerminalTabStrip pane={pane} tabId="tab1" hasSplits={false} />);

    const tab = getByRole("tab");
    fireEvent.mouseDown(tab, { button: 1 });
    fireEvent(tab, new MouseEvent("auxclick", { button: 1, bubbles: true }));

    const tabState = useTerminalStore.getState().tabs["tab1"];
    expect((tabState.root as PaneNode).terminals).toEqual(["t1"]);
  });
});
