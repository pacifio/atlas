import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTurnIndexScheduler, sessionProjectPath } from "./turn-index-scheduler";

describe("sessionProjectPath", () => {
  const sessions = {
    native: { acpSessionId: "s-native", workingDirectory: "/p/native", agentType: "atlas-agent" },
    claude: { acpSessionId: "s-claude", workingDirectory: "/p/claude", agentType: "claude-code" },
    codex: { acpSessionId: "s-codex", workingDirectory: "/p/codex", agentType: "codex" },
  };

  it("resolves the project for every agent kind, not only the native agent", () => {
    expect(sessionProjectPath(sessions, "s-native")).toBe("/p/native");
    expect(sessionProjectPath(sessions, "s-claude")).toBe("/p/claude");
    expect(sessionProjectPath(sessions, "s-codex")).toBe("/p/codex");
  });

  it("is undefined for a session it does not know", () => {
    expect(sessionProjectPath(sessions, "s-missing")).toBeUndefined();
  });
});

describe("createTurnIndexScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once per burst of turns, delayMs after the last one", () => {
    const run = vi.fn();
    const scheduler = createTurnIndexScheduler(run, 4000);
    scheduler.schedule("/p/a");
    vi.advanceTimersByTime(3000);
    scheduler.schedule("/p/a");
    vi.advanceTimersByTime(3999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/p/a");
  });

  it("debounces each project on its own", () => {
    const run = vi.fn();
    const scheduler = createTurnIndexScheduler(run, 4000);
    scheduler.schedule("/p/a");
    vi.advanceTimersByTime(2000);
    scheduler.schedule("/p/b");
    vi.advanceTimersByTime(2000);
    expect(run.mock.calls).toEqual([["/p/a"]]);
    vi.advanceTimersByTime(2000);
    expect(run.mock.calls).toEqual([["/p/a"], ["/p/b"]]);
  });

  it("ignores a turn with no project, and cancelAll drops pending runs", () => {
    const run = vi.fn();
    const scheduler = createTurnIndexScheduler(run, 4000);
    scheduler.schedule(undefined);
    scheduler.schedule("");
    scheduler.schedule("/p/a");
    scheduler.cancelAll();
    vi.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
  });
});
