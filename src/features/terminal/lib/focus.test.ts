import { describe, expect, it } from "vitest";
import { focusedTerminalId } from "./focus";
import type { TerminalTabState } from "../stores/terminal-store";

const term: Record<string, TerminalTabState> = {
  "term-tab": {
    root: {
      type: "split",
      id: "s",
      direction: "horizontal",
      children: [
        { type: "pane", id: "p1", terminals: ["t1", "t2"], activeTerminalId: "t2" },
        { type: "pane", id: "p2", terminals: ["t3"], activeTerminalId: "t3" },
      ],
    },
    activePaneId: "p2",
  },
};
const tabs = [
  { id: "term-tab", type: "terminal", groupId: "main" },
  { id: "editor", type: "editor", groupId: "g2" },
];

describe("focusedTerminalId", () => {
  it("walks focused column → active tab → active pane → active terminal", () => {
    expect(
      focusedTerminalId(
        { tabs, focusedGroupId: "main", activeByGroup: { main: "term-tab", g2: "editor" } },
        { tabs: term },
      ),
    ).toBe("t3");
  });

  it("is null when the focused column shows a non-terminal tab", () => {
    expect(
      focusedTerminalId(
        { tabs, focusedGroupId: "g2", activeByGroup: { main: "term-tab", g2: "editor" } },
        { tabs: term },
      ),
    ).toBeNull();
  });

  it("is null when the terminal tab is not the active tab of its column", () => {
    expect(
      focusedTerminalId(
        { tabs, focusedGroupId: "main", activeByGroup: { main: "other", g2: "editor" } },
        { tabs: term },
      ),
    ).toBeNull();
  });
});
