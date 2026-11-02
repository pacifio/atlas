// The Organisation agent's UI state. A conversation lives in one place at a
// time — the side panel (its home), the floating messenger, or the full page
// — and keeps its panel tab wherever it is, so the panel can say where it
// went. Conversations name themselves from their first prompt. The reply is
// the placeholder seam (`org-agent-api.ts`), stubbed here.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/org-agent-api", async (actual) => ({
  ...(await actual<typeof import("../lib/org-agent-api")>()),
  reply: vi.fn(async () => ({ text: "An answer.", thoughtMs: 1200 })),
}));

import { NEW_CHAT_TITLE, useOrgAgentStore } from "./org-agent-store";

const actions = () => useOrgAgentStore.getState().actions;
const state = () => useOrgAgentStore.getState();

beforeEach(() => {
  useOrgAgentStore.setState({
    conversations: {},
    tabs: [],
    activeId: null,
    floatingId: null,
    pageId: null,
    unread: [],
    pending: [],
  });
});

describe("org agent store", () => {
  it("opens a new chat as the panel's active tab", () => {
    const id = actions().newChat();
    expect(state().tabs).toEqual([id]);
    expect(state().activeId).toBe(id);
    expect(state().conversations[id].title).toBe(NEW_CHAT_TITLE);
  });

  it("names the conversation from its first prompt, and answers with what the server said", async () => {
    const id = actions().newChat();
    actions().send(id, "What did I work on this week?\nand more");
    expect(state().conversations[id].title).toBe("What did I work on this week?");
    expect(state().pending).toEqual([id]);
    await vi.waitFor(() => expect(state().pending).toEqual([]));
    const answer = state().conversations[id].messages[1];
    expect(answer.role).toBe("assistant");
    expect(answer.thoughtMs).toBe(1200);
    // On screen when it landed: not unread.
    expect(state().unread).toEqual([]);
  });

  it("minimise floats a conversation and keeps its tab; maximise brings it home", () => {
    const id = actions().newChat();
    actions().minimise(id);
    expect(state().floatingId).toBe(id);
    expect(state().tabs).toEqual([id]);
    actions().restoreToPanel(id);
    expect(state().floatingId).toBeNull();
    expect(state().activeId).toBe(id);
  });

  it("full screen moves a conversation to the page, out of the messenger", () => {
    const id = actions().newChat();
    actions().minimise(id);
    actions().fullScreen(id);
    expect(state().pageId).toBe(id);
    expect(state().floatingId).toBeNull();
    expect(state().tabs).toEqual([id]);
    actions().restoreToPanel(id);
    expect(state().pageId).toBeNull();
  });

  it("an answer that lands off screen is unread until its conversation is shown", async () => {
    const asked = actions().newChat();
    actions().send(asked, "hello");
    actions().newChat(); // another tab takes the panel
    await vi.waitFor(() => expect(state().pending).toEqual([]));
    expect(state().unread).toEqual([asked]);
    actions().activate(asked);
    expect(state().unread).toEqual([]);
  });

  it("closing a tab keeps a conversation with messages, drops an empty one, and the neighbour takes over", () => {
    const kept = actions().newChat();
    actions().send(kept, "keep me");
    const empty = actions().newChat();
    actions().closeTab(empty);
    expect(state().conversations[empty]).toBeUndefined();
    expect(state().activeId).toBe(kept);
    actions().closeTab(kept);
    expect(state().tabs).toEqual([]);
    expect(state().conversations[kept]).toBeDefined();
  });

  it("asks again: the last answer is replaced, not added to", async () => {
    const id = actions().newChat();
    actions().send(id, "hello");
    await vi.waitFor(() => expect(state().pending).toEqual([]));
    actions().retry(id);
    await vi.waitFor(() => expect(state().pending).toEqual([]));
    expect(state().conversations[id].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("the full page does not hoard the empty conversations it opens on", () => {
    const first = actions().newChat({ on: "page" });
    expect(state().pageId).toBe(first);
    expect(state().tabs).toEqual([]);
    const second = actions().newChat({ on: "page" });
    expect(state().conversations[first]).toBeUndefined();
    expect(state().pageId).toBe(second);
  });
});
