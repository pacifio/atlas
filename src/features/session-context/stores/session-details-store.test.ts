// @vitest-environment happy-dom
//
// The Details store merged two stores. What has to survive the merge: the
// session overview's persisted preference (which sections the reader folded)
// carried over once and its old key removed, and the deep link (⌘⌥C, the
// palette) opening the card at its capture view in whichever form the
// session's panel can show it.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { OPEN_CAPTURE_EVENT, openCapture } from "../lib/open-capture";
import {
  DETAILS_STORAGE_KEY,
  LEGACY_OVERVIEW_KEY,
  adoptLegacyDetailsPrefs,
  openSessionDetails,
  useSessionDetailsStore,
} from "./session-details-store";

const TAB = "chat-1";

/** A main column showing `activeId`, a session tab when `chat`. */
function showInMain(activeId: string, chat: boolean) {
  useLayoutStore.setState({
    tabs: [
      {
        id: activeId,
        type: chat ? "chat" : "editor",
        title: "x",
        closable: true,
        dirty: false,
        data: {},
        groupId: "main",
      },
    ],
    groupOrder: ["main"],
    activeByGroup: { main: activeId },
  });
}

beforeEach(() => {
  useSessionDetailsStore.setState({
    open: {},
    popoverFor: null,
    dockable: {},
    view: "main",
    collapsed: {},
  });
  // After the reset, which the persist middleware writes through.
  localStorage.clear();
  useChatStore.setState({ sessions: {} });
});

describe("migrating the session overview's preference", () => {
  it("carries the folded sections over once, mapped, and removes the old key", () => {
    localStorage.setItem(
      LEGACY_OVERVIEW_KEY,
      JSON.stringify({
        state: { collapsed: { subagents: true, memories: true, session: true } },
        version: 1,
      }),
    );
    adoptLegacyDetailsPrefs(localStorage);
    expect(localStorage.getItem(LEGACY_OVERVIEW_KEY)).toBeNull();
    const saved = JSON.parse(localStorage.getItem(DETAILS_STORAGE_KEY)!);
    // Subagents is the Lineage section now; the Session card no longer folds.
    expect(saved.state.collapsed).toEqual({ lineage: true, memory: true });

    // A second run finds nothing to read and changes nothing.
    adoptLegacyDetailsPrefs(localStorage);
    expect(JSON.parse(localStorage.getItem(DETAILS_STORAGE_KEY)!)).toEqual(saved);
  });

  it("never overwrites a preference the Details card already saved", () => {
    const mine = JSON.stringify({ state: { collapsed: { changes: true } }, version: 0 });
    localStorage.setItem(DETAILS_STORAGE_KEY, mine);
    localStorage.setItem(
      LEGACY_OVERVIEW_KEY,
      JSON.stringify({ state: { collapsed: { memories: true } } }),
    );
    adoptLegacyDetailsPrefs(localStorage);
    expect(localStorage.getItem(DETAILS_STORAGE_KEY)).toBe(mine);
    expect(localStorage.getItem(LEGACY_OVERVIEW_KEY)).toBeNull();
  });

  it("survives an unreadable old value", () => {
    localStorage.setItem(LEGACY_OVERVIEW_KEY, "{not json");
    expect(() => adoptLegacyDetailsPrefs(localStorage)).not.toThrow();
    expect(localStorage.getItem(LEGACY_OVERVIEW_KEY)).toBeNull();
  });

  it("the store hydrates what was carried over", async () => {
    localStorage.setItem(
      DETAILS_STORAGE_KEY,
      JSON.stringify({ state: { collapsed: { lineage: true } }, version: 0 }),
    );
    await useSessionDetailsStore.persist.rehydrate();
    expect(useSessionDetailsStore.getState().collapsed).toEqual({ lineage: true });
  });
});

describe("the capture deep link", () => {
  it("opens the docked card at its capture view where the panel can dock it", () => {
    showInMain(TAB, true);
    useSessionDetailsStore.getState().actions.setDockable(TAB, true);
    expect(openSessionDetails("capture")).toBe(true);
    const s = useSessionDetailsStore.getState();
    expect(s.open[`t:${TAB}`]).toBe(true);
    expect(s.popoverFor).toBeNull();
    expect(s.view).toBe("capture");
  });

  it("opens the popover at its capture view anywhere else", () => {
    showInMain(TAB, true);
    expect(openSessionDetails("capture")).toBe(true);
    const s = useSessionDetailsStore.getState();
    expect(s.popoverFor).toBe(`t:${TAB}`);
    expect(s.view).toBe("capture");
  });

  it("keys the card by the session once it is bound", () => {
    showInMain(TAB, true);
    useChatStore.setState({ sessions: { [TAB]: { acpSessionId: "acp-9" } } } as never);
    openSessionDetails("capture");
    expect(useSessionDetailsStore.getState().popoverFor).toBe("s:acp-9");
  });

  it("with no session in the main column, opens nothing and hands over to the project label", () => {
    showInMain("editor-1", false);
    const heard = vi.fn();
    window.addEventListener(OPEN_CAPTURE_EVENT, heard);
    openCapture();
    window.removeEventListener(OPEN_CAPTURE_EVENT, heard);
    expect(heard).toHaveBeenCalledOnce();
    expect(useSessionDetailsStore.getState().popoverFor).toBeNull();
  });

  it("a session in the main column takes it, and the label hears nothing", () => {
    showInMain(TAB, true);
    const heard = vi.fn();
    window.addEventListener(OPEN_CAPTURE_EVENT, heard);
    openCapture();
    window.removeEventListener(OPEN_CAPTURE_EVENT, heard);
    expect(heard).not.toHaveBeenCalled();
    expect(useSessionDetailsStore.getState().view).toBe("capture");
  });

  it("closing the card returns the next look to the sections", () => {
    showInMain(TAB, true);
    openSessionDetails("capture");
    useSessionDetailsStore.getState().actions.setPopover(`t:${TAB}`, false);
    expect(useSessionDetailsStore.getState().view).toBe("main");
  });
});
