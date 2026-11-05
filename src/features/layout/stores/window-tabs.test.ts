// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  TEAM_CHAT_TAB,
  groupOf,
  persistsInEditorState,
  restoredTabType,
  useLayoutStore,
  type ProjectView,
  type Tab,
} from "./layout-store";
import {
  revealTeamChat,
  teamChatDestinationShown,
  teamChatShown,
  teamChatSurfaceShown,
  toggleTeamChat,
  toggleTeamChatDestination,
} from "../lib/team-chat";
import { openSurface, SURFACES } from "../lib/surfaces";

/**
 * Team chat belongs to the window, not a project (`WINDOW_TYPES`): it follows
 * the user between projects, one per window, and whether it was open is a
 * layout preference rather than project state. It is a surface tab and a
 * destination both (ADR-0024's amendment), and still one per window across
 * the two forms.
 */

const layout = () => useLayoutStore.getState();
const actions = () => layout().actions;

const tab = (id: string, type: Tab["type"], groupId: string): Tab => ({
  id,
  type,
  title: id,
  closable: true,
  dirty: false,
  data: {},
  groupId,
});

const view = (tabs: Tab[], groupOrder: string[], active: Record<string, string>): ProjectView => ({
  tabs,
  activeTabId: active[groupOrder[0]],
  groupOrder,
  activeByGroup: active,
  focusedGroupId: groupOrder[0],
  tabHistory: [],
  tabHistoryIndex: 0,
});

beforeEach(() => {
  useLayoutStore.setState({
    tabs: [tab("chat-a", "chat", "main")],
    groupOrder: ["main"],
    activeByGroup: { main: "chat-a" },
    focusedGroupId: "main",
    activeTabId: "chat-a",
    surfaces: "shown",
    zen: false,
    zenPrev: null,
    destination: null,
    destinationShown: false,
    lastForm: {},
    viewsByWs: {
      b: view([tab("chat-b", "chat", "main"), tab("term-b", "terminal", "b2")], ["main", "b2"], {
        main: "chat-b",
        b2: "term-b",
      }),
      c: view([tab("chat-c", "chat", "main")], ["main"], { main: "chat-c" }),
    },
  });
});

describe("team chat follows the window", () => {
  it("opens beside the session, never over it", () => {
    revealTeamChat("surface");
    const chat = layout().tabs.find((t) => t.type === "team-chat")!;
    expect(groupOf(chat)).not.toBe(layout().groupOrder[0]);
    expect(teamChatShown(layout())).toBe(true);
  });

  it("is one per window: asking for it in another column focuses the open one", () => {
    revealTeamChat("surface");
    actions().addGroup();
    const other = layout().groupOrder[2];
    actions().addTab({ ...TEAM_CHAT_TAB }, other);
    expect(layout().tabs.filter((t) => t.type === "team-chat")).toHaveLength(1);
  });

  it("comes along to the next project, in the same column position, still showing", () => {
    revealTeamChat("surface");
    actions().commitProjectView("a");
    actions().loadProjectView("b");
    const chat = layout().tabs.find((t) => t.type === "team-chat")!;
    expect(groupOf(chat)).toBe("b2");
    expect(layout().activeByGroup.b2).toBe(chat.id);
    expect(layout().tabs.some((t) => t.id === "term-b")).toBe(true);
  });

  it("opens a surfaces column in a project that has none", () => {
    revealTeamChat("surface");
    actions().loadProjectView("c");
    expect(layout().groupOrder.length).toBe(2);
    expect(teamChatShown(layout())).toBe(true);
  });

  it("stays closed in a project left with it open, once it was closed elsewhere", () => {
    revealTeamChat("surface");
    actions().commitProjectView("a");
    actions().loadProjectView("b");
    toggleTeamChat();
    expect(layout().tabs.some((t) => t.type === "team-chat")).toBe(false);
    actions().commitProjectView("b");
    actions().loadProjectView("a");
    expect(layout().tabs.some((t) => t.type === "team-chat")).toBe(false);
  });

  it("is never written to, or restored from, a project's editor state", () => {
    expect(persistsInEditorState({ type: "team-chat", closable: true })).toBe(false);
    expect(restoredTabType("team-chat")).toBeNull();
  });

  it("reopens on launch when it was open, including a save from the right-slot days", () => {
    const merge = useLayoutStore.persist.getOptions().merge!;
    const fresh = { ...layout(), tabs: [tab("welcome-chat", "chat", "main")] };
    const has = (state: unknown) =>
      (state as { tabs: Tab[] }).tabs.some((t) => t.type === "team-chat");
    expect(has(merge({ teamChat: { open: true } }, fresh))).toBe(true);
    expect(has(merge({ teamChat: { open: false } }, fresh))).toBe(false);
    expect(has(merge({ rightPanel: { visible: true, width: 300 } }, fresh))).toBe(true);
    expect(has(merge({ rightPanel: { visible: true, mode: "chat" } }, fresh))).toBe(true);
    expect(has(merge({ rightPanel: { visible: true, mode: "git" } }, fresh))).toBe(false);
  });
});

describe("team chat, a surface and a destination", () => {
  const surfaceTabs = () => layout().tabs.filter((t) => t.type === "team-chat");
  const teamChatSurface = SURFACES.find((x) => x.type === "team-chat")!;

  it("opens as the destination from the sidebar footer, full window", () => {
    toggleTeamChatDestination();
    expect(layout().destination?.type).toBe("team-chat");
    expect(teamChatDestinationShown(layout())).toBe(true);
    expect(surfaceTabs()).toHaveLength(0);
    // The footer button again goes back to the session; it stays mounted.
    toggleTeamChatDestination();
    expect(layout().destinationShown).toBe(false);
    expect(layout().destination?.type).toBe("team-chat");
  });

  it("opens as a surface from the + menu and the launcher, beside the session", () => {
    actions().addGroup();
    openSurface(teamChatSurface, layout().groupOrder[1]);
    expect(surfaceTabs()).toHaveLength(1);
    expect(teamChatSurfaceShown(layout())).toBe(true);
    expect(layout().destination).toBeNull();
  });

  it("moves between the forms rather than duplicating", () => {
    toggleTeamChatDestination();
    actions().addGroup();
    openSurface(teamChatSurface, layout().groupOrder[1]);
    // Out of the destination screen, into the column.
    expect(layout().destination).toBeNull();
    expect(surfaceTabs()).toHaveLength(1);

    toggleTeamChatDestination();
    // Out of the column, onto the destination screen; the emptied surfaces
    // column folds away.
    expect(surfaceTabs()).toHaveLength(0);
    expect(layout().destination?.type).toBe("team-chat");
    expect(layout().groupOrder).toHaveLength(1);
  });

  it("its shortcut opens the destination when it has never been shown", () => {
    toggleTeamChat();
    expect(teamChatDestinationShown(layout())).toBe(true);
    toggleTeamChat();
    expect(teamChatShown(layout())).toBe(false);
  });

  it("its shortcut toggles it in the form it was last shown in", () => {
    revealTeamChat("surface");
    toggleTeamChat();
    expect(surfaceTabs()).toHaveLength(0);
    toggleTeamChat();
    expect(teamChatSurfaceShown(layout())).toBe(true);
    expect(layout().destination).toBeNull();

    toggleTeamChatDestination();
    toggleTeamChat();
    expect(teamChatShown(layout())).toBe(false);
    toggleTeamChat();
    expect(teamChatDestinationShown(layout())).toBe(true);
    expect(surfaceTabs()).toHaveLength(0);
  });

  it("remembers the last form across launches", () => {
    revealTeamChat("surface");
    expect(layout().lastForm["team-chat"]).toBe("surface");
    const partialize = useLayoutStore.persist.getOptions().partialize!;
    expect((partialize(layout()) as { lastForm: unknown }).lastForm).toEqual({
      "team-chat": "surface",
    });
  });

  it("a destination opened over it leaves it where it is", () => {
    revealTeamChat("surface");
    actions().addTab({ ...tab("memory", "memory", "main") });
    expect(surfaceTabs()).toHaveLength(1);
    expect(layout().destination?.type).toBe("memory");
  });
});
