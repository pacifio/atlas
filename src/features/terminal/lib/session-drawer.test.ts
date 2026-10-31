// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import { useChatStore } from "@/features/chat/stores/chat-store";
import { collectPanes, useTerminalStore } from "../stores/terminal-store";
import {
  DEFAULT_DRAWER_HEIGHT,
  drawerHeightFor,
  drawerTabsOwnedBy,
  useSessionDrawerStore,
} from "../stores/session-drawer-store";
import {
  adoptSessionDrawer,
  clampDrawerHeight,
  discardSessionDrawerFor,
  drawerScopeForTab,
  drawerTabId,
  MIN_DRAWER_HEIGHT,
  openSessionDrawer,
  resolveDrawerMaxHeight,
  toggleSessionDrawer,
} from "./session-drawer";

/** Point chat tab `tabId` at a session, the way a bind or "open from history"
 *  does. Only the fields the drawer reads. */
function showSession(tabId: string, session: Record<string, unknown>) {
  useChatStore.setState((s) => ({
    sessions: { ...s.sessions, [tabId]: { messages: [], ...session } as never },
  }));
}

function ptyIds(scope: string): string[] {
  const tab = useTerminalStore.getState().tabs[drawerTabId(scope)];
  return tab ? collectPanes(tab.root).flatMap((p) => p.terminals) : [];
}

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({ sessions: {} });
  useTerminalStore.setState({ tabs: {}, owners: {}, cwds: {}, pendingFocus: null });
  useSessionDrawerStore.setState({
    open: {},
    heights: {},
    lastHeight: DEFAULT_DRAWER_HEIGHT,
    focusedTab: null,
  });
});

describe("toggleSessionDrawer", () => {
  it("opens the session's drawer with a terminal in the session's worktree", () => {
    showSession("chat-1", { acpSessionId: "sA", workingDirectory: "/repo", bindCwd: "/wt/a" });
    expect(toggleSessionDrawer("chat-1")).toBe(true);

    expect(useSessionDrawerStore.getState().open["s:sA"]).toBe(true);
    expect(ptyIds("s:sA")).toHaveLength(1);
    expect(useTerminalStore.getState().cwds[drawerTabId("s:sA")]).toBe("/wt/a");
    // The new terminal takes the keyboard.
    expect(useTerminalStore.getState().pendingFocus?.tabId).toBe(drawerTabId("s:sA"));
    expect(useSessionDrawerStore.getState().focusedTab).toBe(drawerTabId("s:sA"));
  });

  it("opens in the project when the session has no worktree", () => {
    showSession("chat-1", { acpSessionId: "sA", workingDirectory: "/repo" });
    openSessionDrawer("chat-1");
    expect(useTerminalStore.getState().cwds[drawerTabId("s:sA")]).toBe("/repo");
  });

  it("closing hides the drawer and keeps its shells", () => {
    showSession("chat-1", { acpSessionId: "sA", workingDirectory: "/repo" });
    toggleSessionDrawer("chat-1");
    const before = ptyIds("s:sA");

    expect(toggleSessionDrawer("chat-1")).toBe(false);
    expect(useSessionDrawerStore.getState().open["s:sA"]).toBeUndefined();
    expect(useSessionDrawerStore.getState().focusedTab).toBeNull();
    expect(ptyIds("s:sA")).toEqual(before);

    // Reopening finds the same shells, not new ones.
    toggleSessionDrawer("chat-1");
    expect(ptyIds("s:sA")).toEqual(before);
  });
});

describe("per-session state", () => {
  it("each session has its own drawer, kept across session switches", () => {
    showSession("chat-1", { acpSessionId: "sA", workingDirectory: "/repo" });
    toggleSessionDrawer("chat-1");
    const aShells = ptyIds("s:sA");

    // The same tab moves on to another session: its drawer is closed.
    showSession("chat-1", { acpSessionId: "sB", workingDirectory: "/repo" });
    expect(drawerScopeForTab("chat-1")).toBe("s:sB");
    expect(useSessionDrawerStore.getState().open["s:sB"]).toBeUndefined();
    toggleSessionDrawer("chat-1");
    const bShells = ptyIds("s:sB");
    expect(bShells).toHaveLength(1);
    expect(bShells).not.toEqual(aShells);

    // Back to the first: still open, same shells.
    showSession("chat-1", { acpSessionId: "sA", workingDirectory: "/repo" });
    expect(useSessionDrawerStore.getState().open["s:sA"]).toBe(true);
    expect(ptyIds("s:sA")).toEqual(aShells);
  });

  it("a drawer opened before the first message follows the session it binds to", () => {
    showSession("chat-1", { workingDirectory: "/repo" });
    expect(drawerScopeForTab("chat-1")).toBe("t:chat-1");
    toggleSessionDrawer("chat-1");
    useSessionDrawerStore.getState().actions.setHeight("t:chat-1", 333);
    const shells = ptyIds("t:chat-1");

    adoptSessionDrawer("t:chat-1", "s:sNew");
    expect(ptyIds("s:sNew")).toEqual(shells);
    expect(ptyIds("t:chat-1")).toEqual([]);
    expect(useSessionDrawerStore.getState().open).toEqual({ "s:sNew": true });
    expect(drawerHeightFor(useSessionDrawerStore.getState(), "s:sNew")).toBe(333);
  });

  it("deleting the session ends its drawer's shells and forgets it", () => {
    showSession("chat-1", { acpSessionId: "sA", workingDirectory: "/repo" });
    toggleSessionDrawer("chat-1");
    useSessionDrawerStore.getState().actions.setHeight("s:sA", 400);

    discardSessionDrawerFor("sA");
    expect(useTerminalStore.getState().tabs[drawerTabId("s:sA")]).toBeUndefined();
    expect(useSessionDrawerStore.getState().open["s:sA"]).toBeUndefined();
    expect(useSessionDrawerStore.getState().heights["s:sA"]).toBeUndefined();
  });

  it("a project discard finds the drawers that project owns", () => {
    const owners = {
      [drawerTabId("s:a")]: "p1",
      [drawerTabId("s:b")]: "p2",
      "terminal-1": "p1",
    };
    expect(drawerTabsOwnedBy(owners, "p1")).toEqual([drawerTabId("s:a")]);
  });
});

describe("height", () => {
  it("is remembered per session, and a new session starts at the last one dragged", () => {
    const { setHeight } = useSessionDrawerStore.getState().actions;
    expect(drawerHeightFor(useSessionDrawerStore.getState(), "s:a")).toBe(DEFAULT_DRAWER_HEIGHT);
    setHeight("s:a", 420);
    setHeight("s:b", 300);
    const s = useSessionDrawerStore.getState();
    expect(drawerHeightFor(s, "s:a")).toBe(420);
    expect(drawerHeightFor(s, "s:b")).toBe(300);
    expect(drawerHeightFor(s, "s:never-opened")).toBe(300);
  });

  it("persists heights and never the open flag", () => {
    const { setHeight, setOpen } = useSessionDrawerStore.getState().actions;
    setOpen("s:a", true);
    setHeight("s:a", 420);
    const saved = JSON.parse(localStorage.getItem("atlas.session.terminal-drawer") ?? "{}");
    expect(saved.state).toEqual({ heights: { "s:a": 420 }, lastHeight: 420 });
  });

  it("is capped by the window and by the room the column has", () => {
    expect(resolveDrawerMaxHeight({ viewportHeight: 1000 })).toBe(750);
    expect(
      resolveDrawerMaxHeight({ viewportHeight: 1000, columnHeight: 600, reservedHeight: 250 }),
    ).toBe(350);
    // Never below the minimum, however cramped.
    expect(
      resolveDrawerMaxHeight({ viewportHeight: 1000, columnHeight: 200, reservedHeight: 250 }),
    ).toBe(MIN_DRAWER_HEIGHT);
    expect(clampDrawerHeight(50, 600, 280)).toBe(MIN_DRAWER_HEIGHT);
    expect(clampDrawerHeight(900, 600, 280)).toBe(600);
    expect(clampDrawerHeight(Number.NaN, 600, 280)).toBe(280);
  });
});
