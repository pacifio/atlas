import { describe, expect, it } from "vitest";
import {
  INITIAL_COMMAND_PALETTE_UI_STATE,
  RECENT_SESSIONS_GROUP,
  buildCommandPaletteRows,
  buildRootGroups,
  createCommandPaletteSearchState,
  filterCommandPaletteGroups,
  findHighlightedCommandPaletteItem,
  normalizeSearchText,
  reduceCommandPaletteSearchState,
  reduceCommandPaletteUiState,
  stepHighlight,
  type CommandPaletteActionItem,
  type CommandPaletteGroup,
  type CommandPaletteView,
} from "./command-palette-logic";

function action(
  value: string,
  searchTerms: string[],
  extra: Partial<CommandPaletteActionItem> = {},
): CommandPaletteActionItem {
  return {
    kind: "action",
    value,
    searchTerms,
    title: searchTerms[0],
    icon: null,
    run: () => undefined,
    ...extra,
  };
}

const values = (groups: CommandPaletteGroup[]) =>
  groups.map((group) => [group.value, group.items.map((item) => item.value)]);

describe("reduceCommandPaletteUiState", () => {
  it("toggles a mode closed when it is already on screen, and switches otherwise", () => {
    const commands = reduceCommandPaletteUiState(INITIAL_COMMAND_PALETTE_UI_STATE, {
      _tag: "ToggleMode",
      mode: "command",
    });
    expect(commands).toEqual({ open: true, mode: "command" });
    const files = reduceCommandPaletteUiState(commands, { _tag: "ToggleMode", mode: "files" });
    expect(files).toEqual({ open: true, mode: "files" });
    expect(reduceCommandPaletteUiState(files, { _tag: "ToggleMode", mode: "files" }).open).toBe(
      false,
    );
  });

  it("returns from a child search to the palette query it left", () => {
    const child = reduceCommandPaletteUiState(
      { open: true, mode: "command" },
      { _tag: "OpenChildSearch", mode: "files", context: { query: "go to" } },
    );
    expect(child).toEqual({ open: true, mode: "files", parentSearch: { query: "go to" } });
    expect(reduceCommandPaletteUiState(child, { _tag: "BackToCommand" })).toEqual({
      open: true,
      mode: "command",
      restoredSearch: { query: "go to" },
    });
  });

  it("does not go back from a files search opened directly", () => {
    const direct = { open: true, mode: "files" } as const;
    expect(reduceCommandPaletteUiState(direct, { _tag: "BackToCommand" })).toBe(direct);
  });

  it("drops the return context on close, so the next open is fresh", () => {
    const child = reduceCommandPaletteUiState(
      { open: true, mode: "command" },
      { _tag: "OpenChildSearch", mode: "files", context: { query: "x" } },
    );
    const closed = reduceCommandPaletteUiState(child, { _tag: "SetOpen", open: false });
    expect(closed.parentSearch).toBeUndefined();
    expect(reduceCommandPaletteUiState(closed, { _tag: "SetOpen", open: true })).toEqual({
      open: true,
      mode: "command",
    });
  });
});

describe("reduceCommandPaletteSearchState", () => {
  const view: CommandPaletteView = { value: "theme", groups: [] };

  it("pushes a view with an empty query and restores the parent query on back", () => {
    let state = createCommandPaletteSearchState("change");
    state = reduceCommandPaletteSearchState(state, { type: "push", view });
    expect(state.query).toBe("");
    expect(state.views).toHaveLength(1);
    state = reduceCommandPaletteSearchState(state, { type: "query", query: "dark" });
    state = reduceCommandPaletteSearchState(state, { type: "back" });
    expect(state).toEqual({ query: "change", views: [] });
  });

  it("ignores back at the root, and reset clears every view", () => {
    const root = createCommandPaletteSearchState("q");
    expect(reduceCommandPaletteSearchState(root, { type: "back" })).toBe(root);
    const pushed = reduceCommandPaletteSearchState(root, { type: "push", view });
    expect(reduceCommandPaletteSearchState(pushed, { type: "reset", query: "again" })).toEqual({
      query: "again",
      views: [],
    });
  });
});

describe("normalizeSearchText", () => {
  it("folds case and accents and collapses whitespace without a locale", () => {
    expect(normalizeSearchText("  Café   GIT  ")).toBe("cafe git");
    expect(normalizeSearchText("İ")).toBe("i");
  });
});

describe("filterCommandPaletteGroups", () => {
  const actions: CommandPaletteGroup = {
    value: "actions",
    label: "Actions",
    items: [action("settings", ["Open settings"]), action("theme", ["Change theme"])],
  };
  const recent: CommandPaletteGroup = {
    value: RECENT_SESSIONS_GROUP,
    label: "Recent Sessions",
    items: [action("session:a", ["Fix settings page"], { searchRecency: 1 })],
  };

  it("returns the view's own groups for an empty query", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [actions, recent],
      query: "",
      isInSubmenu: false,
      projectSearchItems: [],
      sessionSearchItems: [],
    });
    expect(values(groups)).toEqual([
      ["actions", ["settings", "theme"]],
      [RECENT_SESSIONS_GROUP, ["session:a"]],
    ]);
  });

  it("swaps recent sessions for the session search once a query is typed", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [actions, recent],
      query: "settings",
      isInSubmenu: false,
      projectSearchItems: [action("project:p", ["Settings app"])],
      sessionSearchItems: [action("session:a", ["Fix settings page"], { searchRecency: 1 })],
    });
    expect(values(groups)).toEqual([
      ["actions", ["settings"]],
      ["projects-search", ["project:p"]],
      ["sessions-search", ["session:a"]],
    ]);
  });

  it("narrows to commands with a leading >", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [actions, recent],
      query: ">theme",
      isInSubmenu: false,
      projectSearchItems: [action("project:p", ["theme"])],
      sessionSearchItems: [action("session:b", ["theme"])],
    });
    expect(values(groups)).toEqual([["actions", ["theme"]]]);
  });

  it("ranks a session's title match ahead of a context match, then by recency", () => {
    const sessions = [
      action("session:context", ["Fix navbar spacing", "Project"], { searchRecency: 30 }),
      action("session:old-title", ["Project kickoff", "Other"], { searchRecency: 10 }),
      action("session:new-title", ["Project roadmap", "Other"], { searchRecency: 20 }),
    ];
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "project",
      isInSubmenu: false,
      projectSearchItems: [],
      sessionSearchItems: sessions,
    });
    expect(groups[0]?.items.map((item) => item.value)).toEqual([
      "session:new-title",
      "session:old-title",
      "session:context",
    ]);
  });

  it("matches every word, in any term, and ranks secondary rows last", () => {
    const items = [
      action("secondary", ["Toggle sidebar"], { secondary: true }),
      action("primary", ["Sidebar toggle"]),
      action("miss", ["Toggle terminal"]),
    ];
    const groups = filterCommandPaletteGroups({
      activeGroups: [{ value: "layout", label: "Layout", items }],
      query: "sidebar toggle",
      isInSubmenu: false,
      projectSearchItems: [],
      sessionSearchItems: [],
    });
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["primary", "secondary"]);
  });

  it("searches an id held as a later term", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [],
      query: "abc123",
      isInSubmenu: false,
      projectSearchItems: [],
      sessionSearchItems: [action("session:x", ["Some session", "abc123"])],
    });
    expect(groups[0]?.items.map((item) => item.value)).toEqual(["session:x"]);
  });

  it("searches only the submenu's rows inside a submenu", () => {
    const groups = filterCommandPaletteGroups({
      activeGroups: [{ value: "themes", label: "Themes", items: [action("dark", ["Dark"])] }],
      query: "dark",
      isInSubmenu: true,
      projectSearchItems: [action("project:dark", ["Dark project"])],
      sessionSearchItems: [],
    });
    expect(values(groups)).toEqual([["themes", ["dark"]]]);
  });
});

describe("rows and highlight", () => {
  const groups: CommandPaletteGroup[] = [
    {
      value: "a",
      label: "A",
      items: [action("one", ["One"]), action("two", ["Two"], { disabled: true })],
    },
    { value: "b", label: "B", items: [action("three", ["Three"])] },
  ];

  it("indexes only the selectable items, skipping labels and disabled rows", () => {
    const { rows, itemValues, rowIndexByItemIndex } = buildCommandPaletteRows(groups);
    expect(rows.map((row) => row.key)).toEqual(["group:a", "a:one", "a:two", "group:b", "b:three"]);
    expect(itemValues).toEqual(["one", "three"]);
    expect(rowIndexByItemIndex).toEqual([1, 4]);
  });

  it("never resolves a disabled row as the highlighted item", () => {
    expect(findHighlightedCommandPaletteItem(groups, "two")).toBeNull();
    expect(findHighlightedCommandPaletteItem(groups, "three")?.value).toBe("three");
  });

  it("wraps at both ends", () => {
    const list = ["one", "two", "three"];
    expect(stepHighlight(list, null, 1)).toBe("one");
    expect(stepHighlight(list, null, -1)).toBe("three");
    expect(stepHighlight(list, "three", 1)).toBe("one");
    expect(stepHighlight(list, "one", -1)).toBe("three");
    expect(stepHighlight([], null, 1)).toBeNull();
  });
});

describe("buildRootGroups", () => {
  it("orders Actions, Recent Sessions, then the extra groups, dropping empty ones", () => {
    const groups = buildRootGroups({
      actionItems: [action("a", ["A"])],
      recentSessionItems: [],
      extraGroups: [
        { value: "layout", label: "Layout", items: [action("l", ["L"])] },
        { value: "empty", label: "Empty", items: [] },
      ],
    });
    expect(groups.map((group) => group.value)).toEqual(["actions", "layout"]);
  });
});
