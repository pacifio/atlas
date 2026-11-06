// @vitest-environment happy-dom
//
// Clicking a comment in the overview's comments popup must do what it does in
// the Timeline: move THIS chat to the row, and open the row's thread.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { jumpToCommentAnchor } = await import("./jump-to-comment");
const { useChatCommentsStore, useThreadOpenSignal } = await import("../stores/chat-comments-store");
const { useChatStore } = await import("../stores/chat-store");

const messages = [
  { id: "m-user", role: "user", content: "hello", toolCalls: [] },
  { id: "m-reply", role: "assistant", content: "hi", toolCalls: [] },
];

let jumps: unknown[] = [];
const onJump = (e: Event) => jumps.push((e as CustomEvent).detail);

beforeEach(() => {
  vi.useFakeTimers();
  jumps = [];
  window.addEventListener("atlas:chat-jump", onJump);
  useChatStore.setState((s) => ({
    ...s,
    sessions: { ...s.sessions, t1: { ...s.sessions.t1, messages } as never },
  }));
  const anchors = {
    rowIdByChatKey: new Map([["m-reply", { rowId: "row-reply", anchorKind: "message" as const }]]),
    chatKeyByRowId: new Map([["row-reply", "m-reply"]]),
    ordered: [],
  };
  useChatCommentsStore.getState().actions.setAnchors("t1", anchors as never);
  useChatCommentsStore.getState().actions.clearFocus("t1");
});
afterEach(() => {
  window.removeEventListener("atlas:chat-jump", onJump);
  vi.useRealTimers();
});

describe("jumpToCommentAnchor", () => {
  it("jumps this chat — addressed to its tab — to the commented row's turn", () => {
    jumpToCommentAnchor("t1", "row-reply", "session-row");
    // The reply's turn starts at the reply itself (index 1): the prompt
    // before it is its own row.
    expect(jumps).toEqual([
      { index: 1, tabId: "t1", highlightRowIds: ["p:m-reply", "wk:t:m-reply"] },
    ]);
  });

  it("opens that row's thread, and only that row's", () => {
    const reply = renderHook(() => useThreadOpenSignal("t1", "row-reply"));
    const other = renderHook(() => useThreadOpenSignal("t1", "row-other"));
    expect(reply.result.current).toBeUndefined();
    jumpToCommentAnchor("t1", "row-reply", "session-row");
    reply.rerender();
    other.rerender();
    expect(reply.result.current).toBeTypeOf("number");
    expect(other.result.current).toBeUndefined();
  });

  it("lets the request lapse, so scrolling back later does not reopen it", () => {
    jumpToCommentAnchor("t1", "row-reply", "session-row");
    expect(useChatCommentsStore.getState().focus.t1).toBeDefined();
    vi.advanceTimersByTime(5000);
    expect(useChatCommentsStore.getState().focus.t1).toBeUndefined();
  });

  it("takes a comment on the whole session to the top, with nothing to open", () => {
    jumpToCommentAnchor("t1", "session-row", "session-row");
    expect(jumps).toEqual([{ index: 0, tabId: "t1" }]);
    expect(useChatCommentsStore.getState().focus.t1).toBeUndefined();
  });
});
