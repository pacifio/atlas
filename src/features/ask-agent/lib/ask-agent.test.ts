// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLayoutStore, type Tab } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { resetMentionRegistryForTests } from "@/features/chat/lib/mention-registry";
import type { ChatSendDetail } from "@/features/chat/hooks/use-queue-drain";
import type { ChatInsertDetail } from "@/features/chat/lib/response-selection";
import { askAgent, composeAsk, resolveAskTarget } from "./ask-agent";
import { agentContextMention, type AgentContext } from "./agent-context";
import { askKeyAction, type AskKey } from "./ask-box-keys";
import { contextAt, useAskAgentContext } from "./focused-context";
import { renderHook } from "@testing-library/react";

const open = [
  { tabId: "chat-b", title: "B" },
  { tabId: "chat-a", title: "A" },
];

describe("resolveAskTarget", () => {
  it("takes the session in view for `active`", () => {
    expect(resolveAskTarget("active", "chat-a", open)).toEqual({
      kind: "existing",
      tabId: "chat-a",
    });
  });

  it("falls back to the most recently viewed session, then a new one", () => {
    expect(resolveAskTarget("active", null, open)).toEqual({ kind: "existing", tabId: "chat-b" });
    expect(resolveAskTarget("active", "gone", open)).toEqual({ kind: "existing", tabId: "chat-b" });
    expect(resolveAskTarget("active", null, [])).toEqual({ kind: "new" });
  });

  it("opens a new session for `new`, and refuses a session that is not open", () => {
    expect(resolveAskTarget("new", "chat-a", open)).toEqual({ kind: "new" });
    expect(resolveAskTarget("chat-a", "chat-b", open)).toEqual({
      kind: "existing",
      tabId: "chat-a",
    });
    expect(() => resolveAskTarget("chat-z", null, open)).toThrow(/No open session/);
  });
});

describe("composeAsk", () => {
  it("puts the prompt first, then the chips", () => {
    const m = agentContextMention({ kind: "quote", text: "x" }, "q1");
    expect(composeAsk("Fix this:", [m])).toBe("Fix this:\n\n@ctx:q1 ");
    expect(composeAsk("  ", [m])).toBe("@ctx:q1 ");
    expect(composeAsk("Just words", [])).toBe("Just words");
  });
});

describe("askKeyAction", () => {
  const key = (over: Partial<AskKey>): AskKey => ({
    key: "Enter",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    ...over,
  });

  it("sends on ⌘↵ (Ctrl↵ off macOS) and drafts on ⌘⇧↵", () => {
    expect(askKeyAction(key({ metaKey: true }))).toBe("send");
    expect(askKeyAction(key({ ctrlKey: true }))).toBe("send");
    expect(askKeyAction(key({ metaKey: true, shiftKey: true }))).toBe("draft");
  });

  it("leaves a plain or shifted Enter to the field, and cancels on Esc", () => {
    expect(askKeyAction(key({}))).toBeNull();
    expect(askKeyAction(key({ shiftKey: true }))).toBeNull();
    expect(askKeyAction(key({ metaKey: true, altKey: true }))).toBeNull();
    expect(askKeyAction(key({ key: "Escape" }))).toBe("cancel");
  });

  it("does nothing while an IME composes", () => {
    expect(askKeyAction(key({ metaKey: true, isComposing: true }))).toBeNull();
  });
});

describe("the focused context", () => {
  it("is the nearest registered element's, given the selection", () => {
    const row = document.createElement("div");
    const cell = document.createElement("span");
    row.append(cell);
    const ctx: AgentContext = { kind: "commit", sha: "abc", subject: "s" };
    const { result } = renderHook(() =>
      useAskAgentContext<HTMLDivElement>((sel) =>
        sel ? [ctx, { kind: "quote", text: sel }] : [ctx],
      ),
    );
    result.current(row);
    expect(contextAt(cell, null)).toEqual([ctx]);
    expect(contextAt(cell, "words")).toEqual([ctx, { kind: "quote", text: "words" }]);
  });

  it("is a selection as a quote, or nothing, elsewhere", () => {
    const loose = document.createElement("p");
    expect(contextAt(loose, "picked")).toEqual([{ kind: "quote", text: "picked" }]);
    expect(contextAt(loose, null)).toEqual([]);
    expect(contextAt(null, "  ")).toEqual([]);
  });
});

describe("askAgent", () => {
  const chatTab = (id: string): Tab => ({
    id,
    type: "chat",
    title: id,
    closable: true,
    dirty: false,
    data: {},
  });
  const ctx: AgentContext = { kind: "error", source: "git push", message: "rejected" };
  const listeners: Array<[string, EventListener]> = [];
  const listen = (name: string, fn: (e: CustomEvent) => void) => {
    const l = fn as EventListener;
    listeners.push([name, l]);
    window.addEventListener(name, l);
  };

  beforeEach(() => {
    resetMentionRegistryForTests();
    useLayoutStore.setState(useLayoutStore.getInitialState(), true);
    useLayoutStore.getState().actions.addTab(chatTab("chat-a"));
    useChatStore.getState().actions.createSession("chat-a");
    useChatStore.getState().actions.setDraft("chat-a", "");
  });
  afterEach(() => {
    for (const [name, l] of listeners.splice(0)) window.removeEventListener(name, l);
  });

  it("sends through the session's own send path, chips and all", async () => {
    let got: ChatSendDetail | null = null;
    listen("atlas:chat-send", (e) => {
      got = e.detail as ChatSendDetail;
      e.preventDefault();
    });
    const result = await askAgent({ context: [ctx], prompt: "Fix this:", send: true });
    expect(result).toMatchObject({ tabId: "chat-a", sent: true, created: false });
    const detail = got as unknown as ChatSendDetail;
    expect(detail.tabId).toBe("chat-a");
    expect(detail.mentions).toHaveLength(1);
    expect(detail.text).toBe(`Fix this:\n\n@ctx:${detail.mentions?.[0].id}`);
  });

  it("drafts into the mounted composer, appending, without navigating", async () => {
    const before = useLayoutStore.getState().activeTabId;
    let got: ChatInsertDetail | null = null;
    listen("atlas:chat-insert", (e) => {
      got = e.detail as ChatInsertDetail;
      e.preventDefault();
    });
    const result = await askAgent({ context: [ctx], send: false });
    expect(result.sent).toBe(false);
    expect(got).toMatchObject({ tabId: "chat-a", append: true });
    expect(useLayoutStore.getState().activeTabId).toBe(before);
  });

  it("writes the stored draft when no composer took it, and when a send was not heard", async () => {
    useChatStore.getState().actions.setDraft("chat-a", "half typed");
    const result = await askAgent({ context: [ctx], prompt: "Look", send: true });
    expect(result.sent).toBe(false);
    expect(useChatStore.getState().drafts["chat-a"]).toMatch(/^half typed\n\nLook\n\n@ctx:\w+ $/);
  });

  it("opens a new session in the background when asked", async () => {
    const send = vi.fn((e: CustomEvent) => e.preventDefault());
    listen("atlas:chat-send", send);
    const active = useLayoutStore.getState().activeTabId;
    const result = await askAgent({ context: [ctx], send: true, target: "new" });
    expect(result.created).toBe(true);
    expect(result.tabId).not.toBe("chat-a");
    expect(useLayoutStore.getState().tabs.some((t) => t.id === result.tabId)).toBe(true);
    expect(useLayoutStore.getState().activeTabId).toBe(active);
    expect(useChatStore.getState().activeSessionId).toBe("chat-a");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty ask", async () => {
    await expect(askAgent({ context: [], prompt: " ", send: true })).rejects.toThrow();
  });
});
