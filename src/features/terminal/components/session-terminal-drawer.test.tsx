// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { useTerminalStore } from "../stores/terminal-store";
import { DEFAULT_DRAWER_HEIGHT, useSessionDrawerStore } from "../stores/session-drawer-store";
import { drawerTabId } from "../lib/session-drawer";
import { SessionTerminalDrawer } from "./session-terminal-drawer";

// The real panel mounts the block terminal and its PTY; the drawer only hands
// it a tab id, a visibility and a variant.
const panelRenders = vi.fn();
vi.mock("./terminal-panel", () => ({
  TerminalPanel: (props: { tabId: string; visible?: boolean; variant?: string }) => {
    panelRenders(props);
    return <div data-testid="panel" data-tab={props.tabId} data-variant={props.variant} />;
  },
}));
vi.mock("@/features/layout/lib/use-tab-visible", () => ({ useIsTabVisible: () => true }));

const SCOPE = "s:sA";

beforeEach(() => {
  panelRenders.mockClear();
  useTerminalStore.setState({ tabs: {}, owners: {}, cwds: {}, pendingFocus: null });
  useSessionDrawerStore.setState({
    open: {},
    heights: {},
    lastHeight: DEFAULT_DRAWER_HEIGHT,
    focusedTab: null,
  });
});
afterEach(cleanup);

function openDrawer(height?: number) {
  act(() => {
    useTerminalStore.getState().actions.initTab(drawerTabId(SCOPE), undefined, "/repo");
    if (height) useSessionDrawerStore.getState().actions.setHeight(SCOPE, height);
    useSessionDrawerStore.getState().actions.setOpen(SCOPE, true);
  });
}

describe("SessionTerminalDrawer", () => {
  it("renders nothing while closed", () => {
    const { container } = render(<SessionTerminalDrawer tabId="chat-1" scope={SCOPE} />);
    expect(container).toBeEmptyDOMElement();
    expect(panelRenders).not.toHaveBeenCalled();
  });

  it("open, shows the session's terminal tab at its remembered height", async () => {
    render(<SessionTerminalDrawer tabId="chat-1" scope={SCOPE} />);
    openDrawer(360);
    const panel = await screen.findByTestId("panel");
    expect(panel).toHaveAttribute("data-tab", drawerTabId(SCOPE));
    expect(panel).toHaveAttribute("data-variant", "drawer");
    const drawer = panel.closest("[data-session-terminal-drawer]") as HTMLElement;
    expect(drawer.style.height).toBe("360px");
  });

  it("re-renders nothing in the panel when only the height changes", async () => {
    render(<SessionTerminalDrawer tabId="chat-1" scope={SCOPE} />);
    openDrawer();
    await screen.findByTestId("panel");
    const renders = panelRenders.mock.calls.length;
    act(() => useSessionDrawerStore.getState().actions.setHeight(SCOPE, 400));
    expect(panelRenders.mock.calls.length).toBe(renders);
  });

  it("closes when its last terminal is closed", async () => {
    render(<SessionTerminalDrawer tabId="chat-1" scope={SCOPE} />);
    openDrawer();
    await screen.findByTestId("panel");
    act(() => useTerminalStore.getState().actions.removeTabs([drawerTabId(SCOPE)]));
    expect(useSessionDrawerStore.getState().open[SCOPE]).toBeUndefined();
    expect(screen.queryByTestId("panel")).not.toBeInTheDocument();
  });

  it("another session's drawer stays closed", async () => {
    render(
      <>
        <SessionTerminalDrawer tabId="chat-1" scope={SCOPE} />
        <SessionTerminalDrawer tabId="chat-2" scope="s:sB" />
      </>,
    );
    openDrawer();
    await screen.findByTestId("panel");
    expect(screen.getAllByTestId("panel")).toHaveLength(1);
  });
});
