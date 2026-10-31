// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { liveWhenContext } from "./when-context";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

describe("liveWhenContext", () => {
  // The review diff owns ⌘F (`diff.find`) only while it is the active tab;
  // a session beside it keeps its own find the rest of the time.
  it.each(["diff", "session-changes"])("is diffFocus while a %s tab is active", (type) => {
    useLayoutStore.setState({
      tabs: [{ id: "r", type, title: "Changes", data: {} }],
      activeTabId: "r",
      destinationShown: false,
    } as never);
    const ctx = liveWhenContext();
    expect(ctx.diffFocus).toBe(true);
    expect(ctx.chatFocus).toBeUndefined();
  });

  it("is chatFocus, not diffFocus, while the session is active", () => {
    useLayoutStore.setState({
      tabs: [{ id: "c", type: "chat", title: "Session", data: {} }],
      activeTabId: "c",
      destinationShown: false,
    } as never);
    const ctx = liveWhenContext();
    expect(ctx.chatFocus).toBe(true);
    expect(ctx.diffFocus).toBeUndefined();
  });
});
