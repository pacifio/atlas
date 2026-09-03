import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearHandlersForTest, registerHandlers, runAction } from "./handler-registry";

beforeEach(clearHandlersForTest);

describe("runAction", () => {
  it("reports that nothing is listening rather than swallowing the keystroke", () => {
    expect(runAction("chat-find", null)).toBe(false);
  });

  it("runs a window-wide handler whatever tab is focused", () => {
    const run = vi.fn();
    registerHandlers({ "command-palette": run });

    expect(runAction("command-palette", "chat-2")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs the focused pane's handler, not its neighbour's in the same split", () => {
    const left = vi.fn();
    const right = vi.fn();
    registerHandlers({ "chat-find": left }, "chat-left");
    registerHandlers({ "chat-find": right }, "chat-right");

    expect(runAction("chat-find", "chat-right")).toBe(true);
    expect(right).toHaveBeenCalledOnce();
    expect(left).not.toHaveBeenCalled();
  });

  it("leaves a pane command alone when its pane isn't the focused one", () => {
    const paneHandler = vi.fn();
    registerHandlers({ "chat-find": paneHandler }, "chat-left");

    expect(runAction("chat-find", "terminal-1")).toBe(false);
    expect(paneHandler).not.toHaveBeenCalled();
  });

  it("prefers the most recent registration, so a remount can't leave a stale one in front", () => {
    const stale = vi.fn();
    const fresh = vi.fn();
    registerHandlers({ "editor-save": stale }, "editor-1");
    registerHandlers({ "editor-save": fresh }, "editor-1");

    runAction("editor-save", "editor-1");

    expect(fresh).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
  });

  it("lets a handler decline, so the keystroke isn't swallowed by a no-op", () => {
    // What the terminal's find does while an alt-screen app is running: the
    // command is still declared, but there is no block history to search.
    registerHandlers({ "terminal-find": () => false }, "terminal-1");

    expect(runAction("terminal-find", "terminal-1")).toBe(false);
  });

  it("stops running a handler once its component unregisters", () => {
    const run = vi.fn();
    const unregister = registerHandlers({ "close-tab": run });

    unregister();

    expect(runAction("close-tab", null)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("unregisters only its own entry when two are live for one command", () => {
    const gone = vi.fn();
    const stays = vi.fn();
    const unregisterGone = registerHandlers({ "chat-find": gone }, "chat-1");
    registerHandlers({ "chat-find": stays }, "chat-2");

    unregisterGone();

    expect(runAction("chat-find", "chat-2")).toBe(true);
    expect(stays).toHaveBeenCalledOnce();
    expect(runAction("chat-find", "chat-1")).toBe(false);
    expect(gone).not.toHaveBeenCalled();
  });
});
