import { describe, expect, it } from "vitest";
import {
  fileChipDisplayName,
  mergeQueued,
  planSubmit,
  submitButtonState,
  type SubmitInput,
} from "./composer-submit";

const idle: SubmitInput = {
  text: "hello",
  disabled: false,
  githubSyncing: false,
  running: false,
  remoteDriving: false,
  modeUnrestored: false,
  heldForTerminal: false,
  supportsFork: false,
};
const plan = (over: Partial<SubmitInput>) => planSubmit({ ...idle, ...over });

describe("planSubmit", () => {
  it("sends trimmed text when nothing gates it", () => {
    expect(plan({ text: "  hi  " })).toEqual({ kind: "send", text: "hi" });
  });

  it("blocks while disabled or while a repo syncs", () => {
    expect(plan({ disabled: true })).toEqual({ kind: "blocked" });
    expect(plan({ githubSyncing: true })).toEqual({ kind: "blocked" });
  });

  it("is a stop when empty and running, a noop when empty and idle", () => {
    expect(plan({ text: "   ", running: true })).toEqual({ kind: "stop" });
    expect(plan({ text: "" })).toEqual({ kind: "noop" });
  });

  it("checks disabled before the empty-while-running stop", () => {
    expect(plan({ text: "", running: true, disabled: true })).toEqual({ kind: "blocked" });
  });

  it("blocks everything typed, /queue included, while someone else drives", () => {
    expect(plan({ remoteDriving: true })).toEqual({ kind: "blocked" });
    expect(plan({ text: "/queue later", remoteDriving: true })).toEqual({ kind: "blocked" });
    // Empty while running is still the owner's Stop.
    expect(plan({ text: "", running: true, remoteDriving: true })).toEqual({ kind: "stop" });
  });

  it("forks only when the agent supports it", () => {
    expect(plan({ text: " /fork ", supportsFork: true })).toEqual({ kind: "fork" });
    expect(plan({ text: "/fork" })).toEqual({ kind: "send", text: "/fork" });
  });

  it("parses /queue with and without a message", () => {
    expect(plan({ text: "/queue  do it  " })).toEqual({
      kind: "queue-command",
      message: "do it",
    });
    expect(plan({ text: "/queue" })).toEqual({ kind: "queue-command", message: null });
    expect(plan({ text: "/queued" })).toEqual({ kind: "send", text: "/queued" });
  });

  it("enqueues while running, ahead of the mode and terminal gates", () => {
    expect(plan({ running: true })).toEqual({ kind: "enqueue", text: "hello" });
    expect(plan({ running: true, modeUnrestored: true, heldForTerminal: true })).toEqual({
      kind: "enqueue",
      text: "hello",
    });
  });

  it("blocks an idle send on an unrestored mode or a session held elsewhere", () => {
    expect(plan({ modeUnrestored: true })).toEqual({ kind: "blocked" });
    expect(plan({ heldForTerminal: true })).toEqual({ kind: "blocked" });
  });
});

describe("submitButtonState", () => {
  const base = {
    running: false,
    hasText: false,
    disabled: false,
    modeUnrestored: false,
    heldForTerminal: false,
    remoteDriving: false,
  };
  const state = (over: Partial<typeof base>) => submitButtonState({ ...base, ...over });

  it("sends when idle, enabled only with text", () => {
    expect(state({})).toEqual({ mode: "send", enabled: false });
    expect(state({ hasText: true })).toEqual({ mode: "send", enabled: true });
  });

  it("stops when running and empty, queues when running with text", () => {
    expect(state({ running: true })).toEqual({ mode: "stop", enabled: true });
    expect(state({ running: true, hasText: true })).toEqual({ mode: "queue", enabled: true });
  });

  it("stays a live stop while someone else drives", () => {
    expect(state({ running: true, hasText: true, remoteDriving: true })).toEqual({
      mode: "stop",
      enabled: true,
    });
    expect(state({ hasText: true, remoteDriving: true })).toEqual({
      mode: "send",
      enabled: false,
    });
  });

  it("disables send on the mode and terminal gates, and everything when disabled", () => {
    expect(state({ hasText: true, modeUnrestored: true }).enabled).toBe(false);
    expect(state({ hasText: true, heldForTerminal: true }).enabled).toBe(false);
    expect(state({ running: true, heldForTerminal: true }).enabled).toBe(true);
    expect(state({ running: true, disabled: true })).toEqual({ mode: "stop", enabled: false });
  });
});

describe("helpers", () => {
  it("mergeQueued joins onto existing text with a newline", () => {
    expect(mergeQueued("", "b")).toBe("b");
    expect(mergeQueued("  ", "b")).toBe("b");
    expect(mergeQueued("a", "b")).toBe("a\nb");
  });

  it("fileChipDisplayName is project-relative inside the project, else the basename", () => {
    expect(fileChipDisplayName("/p/src/a.ts", "/p")).toBe("src/a.ts");
    expect(fileChipDisplayName("/p/src/a.ts", "/p/")).toBe("src/a.ts");
    expect(fileChipDisplayName("/other/b.png", "/p")).toBe("b.png");
    expect(fileChipDisplayName("/px/b.png", "/p")).toBe("b.png");
    expect(fileChipDisplayName("/x/c.txt", null)).toBe("c.txt");
  });
});
