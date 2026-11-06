// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { openSessionChanges } from "./open-session-changes";
import { useDiffJump } from "./diff-jump";
import { useDiffPanelStore } from "../stores/diff-panel-store";

const chat = (id: string) => ({
  id,
  type: "chat" as const,
  title: id,
  closable: true,
  dirty: false,
  data: {},
});

const layout = () => useLayoutStore.getState();
const groupOf = (id: string) => layout().tabs.find((t) => t.id === id)?.groupId ?? "main";
const open = (sessionId: string, file: string) =>
  openSessionChanges({ projectPath: "/p", sessionId, file, title: "thread" });

beforeEach(() => {
  useLayoutStore.setState(useLayoutStore.getInitialState(), true);
  useDiffPanelStore.setState({ scope: {}, turn: {} });
  layout().actions.addTab(chat("chat-1"));
});

describe("openSessionChanges", () => {
  it("opens a new split beside the chat on the first click", () => {
    open("s1", "a.ts");
    expect(layout().groupOrder).toHaveLength(2);
    expect(groupOf("session-changes:s1")).not.toBe(groupOf("chat-1"));
    expect(layout().activeByGroup[groupOf("session-changes:s1")]).toBe("session-changes:s1");
  });

  it("reuses the open tab — no new tab, no new split — on later clicks", () => {
    open("s1", "a.ts");
    layout().actions.setActiveTab("chat-1");
    open("s1", "b.ts");
    expect(layout().groupOrder).toHaveLength(2);
    expect(layout().tabs.filter((t) => t.type === "session-changes")).toHaveLength(1);
    expect(layout().focusedGroupId).toBe(groupOf("session-changes:s1"));
  });

  it("puts an empty split column to use before making another", () => {
    layout().actions.addGroup();
    const empty = layout().focusedGroupId;
    layout().actions.setActiveTab("chat-1");
    open("s1", "a.ts");
    expect(layout().groupOrder).toHaveLength(2);
    expect(groupOf("session-changes:s1")).toBe(empty);
  });

  it("shares the column of another thread's changes", () => {
    open("s1", "a.ts");
    layout().actions.setActiveTab("chat-1");
    open("s2", "b.ts");
    expect(layout().groupOrder).toHaveLength(2);
    expect(groupOf("session-changes:s2")).toBe(groupOf("session-changes:s1"));
  });

  it("shows the turn asked for in the panel's turn scope", () => {
    openSessionChanges({ projectPath: "/p", sessionId: "s1", file: "a.ts", turnId: "t:m1" });
    const panel = useDiffPanelStore.getState();
    expect(panel.scope["session-changes:s1"]).toBe("turn");
    expect(panel.turn["session-changes:s1"]).toBe("t:m1");
  });

  it("takes a panel left on a turn back to Changes when no turn is asked for", () => {
    openSessionChanges({ projectPath: "/p", sessionId: "s1", file: "a.ts", turnId: "t:m1" });
    open("s1", "b.ts");
    expect(useDiffPanelStore.getState().scope["session-changes:s1"]).toBe("branch-range");
  });

  it("leaves a git scope the reader chose alone", () => {
    useDiffPanelStore.getState().actions.setScope("session-changes:s1", "working-tree");
    open("s1", "b.ts");
    expect(useDiffPanelStore.getState().scope["session-changes:s1"]).toBe("working-tree");
  });

  it("delivers the file to a view that mounts after the click, and to one already mounted", () => {
    open("s1", "a.ts");
    const { result } = renderHook(() => useDiffJump("session-changes:s1"));
    expect(result.current?.path).toBe("a.ts");
    const first = result.current!.nonce;
    act(() => open("s1", "a.ts"));
    expect(result.current?.path).toBe("a.ts");
    expect(result.current!.nonce).not.toBe(first);
  });
});
