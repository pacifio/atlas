// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@/lib/platform", () => ({ isMac: true, isWindows: false, isLinux: false }));
vi.mock("@/components/titlebar", () => ({
  PaneHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
}));
vi.mock("./tab-content-container", () => ({ TabContentContainer: () => null }));
vi.mock("./tab-panels", () => ({
  GROUP_OF: (tab: Tab) => tab.groupId ?? "main",
  TabContent: ({ tab }: { tab: Tab }) => <div data-testid="content">{tab.id}</div>,
}));
vi.mock("@/features/app/components/welcome-screen", () => ({
  WelcomeScreen: () => <div>Welcome</div>,
}));

import { useActionHotkeys } from "@/hooks/use-hotkey";
import { useKeybindingsStore } from "@/features/keybindings/stores/keybindings-store";
import { useHintStore } from "@/features/hint-nav/stores/hint-store";
import { resolveProfile } from "@/features/keybindings/lib/resolve";
import { useAppStore } from "@/features/app/stores/app-store";
import { KnowledgeButton } from "@/features/sidebar/components/sidebar-destinations";
import { toggleDestination } from "../lib/destinations";
import { navigationTabs, useLayoutStore, type Tab } from "../stores/layout-store";
import { PaneTabStrip } from "./pane-tab-strip";
import { TabColumn } from "./tab-column";
import { ProjectlessCenter } from "./projectless-center";

const tab = (id: string, type: Tab["type"], groupId = "main"): Tab => ({
  id,
  type,
  groupId,
  title: id,
  closable: true,
  dirty: false,
  data: {},
});
const none = new Set<string>();
const targets = () => screen.getAllByRole("tab");
const shortcuts = () => targets().map((el) => el.getAttribute("aria-keyshortcuts"));

function Shortcuts({ projectless = false }: { projectless?: boolean }) {
  const { activateTabByIndex, cycleTab, focusAdjacentGroup } = useLayoutStore.use.actions();
  useActionHotkeys({
    "tabs.focus1": () => activateTabByIndex(0, projectless),
    "tabs.focus2": () => activateTabByIndex(1, projectless),
    "tabs.focus9": () => activateTabByIndex(-1, projectless),
    "tabs.prev": () => cycleTab(-1, projectless),
    "tabs.next": () => cycleTab(1, projectless),
    "split.focusLeft": () => focusAdjacentGroup(-1),
    "split.focusRight": () => focusAdjacentGroup(1),
    "panels.knowledge": () => toggleDestination("knowledge"),
  });
  return null;
}

beforeEach(() => {
  useLayoutStore.setState({
    ...useLayoutStore.getInitialState(),
    tabs: [tab("session", "chat"), tab("a", "terminal", "right"), tab("b", "files", "right")],
    groupOrder: ["main", "right"],
    focusedGroupId: "right",
    activeByGroup: { main: "session", right: "a" },
    activeTabId: "a",
  });
  useKeybindingsStore.setState({ recording: false, resolved: resolveProfile(undefined) });
  useHintStore.setState({ open: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("navigation targets in the current shell", () => {
  it("updates the sortable strip's indices and dispatch after a reorder", () => {
    function Strip() {
      const state = useLayoutStore();
      return (
        <PaneTabStrip
          tabs={navigationTabs(state.tabs, state.focusedGroupId)}
          activeId={state.activeTabId}
          focused
          runningTabIds={none}
          onSelect={state.actions.setActiveTab}
          onMove={state.actions.moveTab}
        />
      );
    }
    render(
      <>
        <Strip />
        <Shortcuts />
      </>,
    );
    expect(shortcuts()[0]).toContain("Meta+1");
    expect(shortcuts()[1]).toContain("Meta+2");
    act(() => useLayoutStore.getState().actions.moveTab("b", 0));
    expect(targets()[0].dataset.tabId).toBe("b");
    expect(shortcuts()[0]).toContain("Meta+1");
    fireEvent.keyDown(window, { code: "Digit1", metaKey: true });
    expect(useLayoutStore.getState().activeTabId).toBe("b");
    expect(targets()[0].getAttribute("aria-selected")).toBe("true");
  });

  it("does not assign numeric hints just because an inactive project's strip is lit", () => {
    const state = useLayoutStore.getState();
    render(
      <>
        <PaneTabStrip
          tabs={navigationTabs(state.tabs, "right")}
          activeId="a"
          focused
          navigationEnabled={false}
          runningTabIds={none}
          onSelect={state.actions.setActiveTab}
          onMove={state.actions.moveTab}
        />
        <Shortcuts />
      </>,
    );
    expect(shortcuts()).toEqual([null, null]);
    expect(targets().every((el) => !el.hasAttribute("data-navigation-actions"))).toBe(true);
  });

  it("labels the adjacent session column without inventing a session tab strip", () => {
    // An editor in the main column has no session-switcher dependency.
    useLayoutStore.setState({ tabs: [tab("editor", "editor"), tab("a", "terminal", "right")] });
    render(
      <>
        <TabColumn
          groupId="main"
          role="main"
          view={useLayoutStore.getState()}
          isActive
          runningTabIds={none}
          solo={false}
          atLeft
          atRight={false}
          placementControls={false}
          projectId="project"
        />
        <Shortcuts />
      </>,
    );
    expect(
      screen.getByRole("group", { name: "Pane 1" }).getAttribute("data-navigation-actions"),
    ).toBe("split.focusLeft");
    expect(screen.queryAllByRole("tab")).toEqual([]);
  });

  it("uses visible projectless tabs across saved groups for both hints and dispatch", () => {
    useLayoutStore.setState({
      tabs: [tab("hidden", "chat"), tab("draft", "comms-draft"), tab("team", "team-chat", "right")],
      activeByGroup: { main: "draft", right: "team" },
      focusedGroupId: "main",
      activeTabId: "draft",
    });
    render(
      <>
        <ProjectlessCenter />
        <Shortcuts projectless />
      </>,
    );
    expect(targets().map((el) => el.dataset.tabId)).toEqual(["__home", "draft", "team"]);
    expect(shortcuts()[0]).toBeNull();
    expect(shortcuts()[1]).toContain("Meta+1");
    expect(shortcuts()[2]).toContain("Meta+2");
    fireEvent.keyDown(window, { code: "Digit2", metaKey: true });
    expect(screen.getByTestId("content").textContent).toBe("team");
    expect(useLayoutStore.getState().focusedGroupId).toBe("right");
    fireEvent.keyDown(window, { code: "BracketRight", metaKey: true, shiftKey: true });
    expect(screen.getByTestId("content").textContent).toBe("draft");
    fireEvent.click(targets()[0]);
    expect(shortcuts()).toEqual([null, null, null]);
  });

  it("only advertises Knowledge when its destination button is enabled", () => {
    const previous = useAppStore.getState().currentProject;
    try {
      useAppStore.setState({ currentProject: null });
      render(
        <>
          <KnowledgeButton iconOnly />
          <Shortcuts />
        </>,
      );
      const button = screen.getByRole("button", { name: "Knowledge" });
      expect(button.getAttribute("aria-keyshortcuts")).toBeNull();
      act(() =>
        useAppStore.setState({
          currentProject: { name: "Project", path: "/project" },
        }),
      );
      expect(button.getAttribute("aria-keyshortcuts")).toBe("Alt+J");
      act(() =>
        useKeybindingsStore.setState({
          resolved: resolveProfile({
            id: "custom",
            name: "Custom",
            bindings: { "panels.knowledge": ["cmd+alt+k"] },
          }),
        }),
      );
      expect(button.getAttribute("aria-keyshortcuts")).toBe("Alt+Meta+K");
      fireEvent.keyDown(window, { code: "KeyK", metaKey: true, altKey: true });
      expect(useLayoutStore.getState().destination?.type).toBe("knowledge");
      expect(useLayoutStore.getState().destinationShown).toBe(true);
    } finally {
      useAppStore.setState({ currentProject: previous });
    }
  });
});
