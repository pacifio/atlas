// @vitest-environment happy-dom
//
// The pins store: toggling, ordering, the per-scope cap, and the scope key.

import { beforeEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types/agent";
import { userMessageText } from "../lib/turn-rows";
import { pinScope, pinsFor, resolvePinIndex, useChatPinsStore } from "./chat-pins-store";

const pin = (messageId: string, text = messageId, timestamp = "2026-09-09T11:00:00.000Z") => ({
  messageId,
  timestamp,
  text,
  at: "2026-09-09T12:00:00.000Z",
});

beforeEach(() => {
  localStorage.clear();
  useChatPinsStore.setState({ pins: {} });
});

describe("chat pins", () => {
  it("toggles a message in and back out of its scope", () => {
    const { toggle } = useChatPinsStore.getState().actions;
    toggle("s:abc", pin("m1"));
    expect(pinsFor(useChatPinsStore.getState(), "s:abc")).toHaveLength(1);
    toggle("s:abc", pin("m1"));
    expect(pinsFor(useChatPinsStore.getState(), "s:abc")).toHaveLength(0);
  });

  it("keeps the newest pin first", () => {
    const { toggle } = useChatPinsStore.getState().actions;
    toggle("s:abc", pin("m1"));
    toggle("s:abc", pin("m2"));
    expect(pinsFor(useChatPinsStore.getState(), "s:abc").map((p) => p.messageId)).toEqual([
      "m2",
      "m1",
    ]);
  });

  it("keeps scopes apart", () => {
    const { toggle } = useChatPinsStore.getState().actions;
    toggle("s:abc", pin("m1"));
    toggle("s:def", pin("m2"));
    expect(pinsFor(useChatPinsStore.getState(), "s:abc").map((p) => p.messageId)).toEqual(["m1"]);
    expect(pinsFor(useChatPinsStore.getState(), "s:def").map((p) => p.messageId)).toEqual(["m2"]);
  });

  it("caps a scope, dropping the oldest", () => {
    const { toggle } = useChatPinsStore.getState().actions;
    for (let i = 0; i < 60; i++) toggle("s:abc", pin(`m${i}`));
    const ids = pinsFor(useChatPinsStore.getState(), "s:abc").map((p) => p.messageId);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("m59");
    expect(ids).not.toContain("m0");
  });

  it("unpins by message id", () => {
    const { toggle, unpin } = useChatPinsStore.getState().actions;
    toggle("s:abc", pin("m1"));
    toggle("s:abc", pin("m2"));
    unpin("s:abc", "m1");
    expect(pinsFor(useChatPinsStore.getState(), "s:abc").map((p) => p.messageId)).toEqual(["m2"]);
  });

  it("returns the SAME empty array for an unknown scope", () => {
    // A fresh `[]` per call would make every selector using it re-render on
    // every unrelated store write.
    const state = useChatPinsStore.getState();
    expect(pinsFor(state, "s:nothing")).toBe(pinsFor(state, "s:other"));
  });

  it("scopes by session id once bound, by tab id before that", () => {
    expect(pinScope("tab-1", "sess-9")).toBe("s:sess-9");
    expect(pinScope("tab-1", undefined)).toBe("t:tab-1");
  });
});

describe("resolvePinIndex", () => {
  const msg = (id: string, role: "user" | "assistant", content: string, timestamp: string) =>
    ({
      id,
      role,
      content,
      toolCalls: [],
      fileChanges: [],
      plan: null,
      timestamp,
    }) as ChatMessage;
  const t1 = "2026-09-09T11:00:00.000Z";
  const t2 = "2026-09-09T11:05:00.000Z";

  it("prefers the id while it still exists", () => {
    const messages = [msg("a", "user", "hello", t1), msg("b", "user", "hello", t2)];
    expect(resolvePinIndex(messages, pin("b", "hello", t2))).toBe(1);
  });

  it("survives ids being re-minted by a history load", () => {
    // `replaceMessages` mints `msg-<now>-<i>`; the pin still carries the old id.
    const messages = [
      msg("msg-9-0", "user", "first question", t1),
      msg("msg-9-1", "assistant", "an answer", t1),
      msg("msg-9-2", "user", "second question", t2),
    ];
    expect(resolvePinIndex(messages, pin("msg-1-2", "second question", t2))).toBe(2);
  });

  it("matches the SHOWN text, not the wire text with injected blocks around it", () => {
    const wire =
      "--- RELEVANT PROJECT MEMORY ---\n- something (claude): a memory\n--- END RELEVANT PROJECT MEMORY ---\n\nsecond question";
    const messages = [msg("x", "user", wire, t2)];
    expect(userMessageText(messages[0])).toBe("second question");
    expect(resolvePinIndex(messages, pin("gone", "second question", t2))).toBe(0);
  });

  it("uses the timestamp to pick between identical prompts", () => {
    const messages = [msg("x", "user", "again", t1), msg("y", "user", "again", t2)];
    expect(resolvePinIndex(messages, pin("gone", "again", t2))).toBe(1);
  });

  it("falls back to text alone when the timestamp was invented", () => {
    const messages = [msg("x", "user", "orphan", "2026-01-01T00:00:00.000Z")];
    expect(resolvePinIndex(messages, pin("gone", "orphan", t1))).toBe(0);
  });

  it("never lands on an assistant message with the same prose", () => {
    const messages = [msg("x", "assistant", "hello", t1)];
    expect(resolvePinIndex(messages, pin("gone", "hello", t1))).toBe(-1);
  });
});
