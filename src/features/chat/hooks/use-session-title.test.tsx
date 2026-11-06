// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  rows: [] as Array<{ sessionId: string; title: string }>,
  listeners: new Set<() => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "threads_history" ? backend.rows : undefined,
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: () => void) => {
    if (event !== "atlas:threads-changed") return () => {};
    backend.listeners.add(callback);
    return () => backend.listeners.delete(callback);
  }),
  emit: vi.fn(async () => {}),
}));

import {
  HISTORY_COALESCE_MS,
  resetThreadHistoryForTests,
} from "@/features/session-context/lib/session-lineage";
import { UNTITLED_SESSION, useChatStore } from "../stores/chat-store";
import { useSessionTitle } from "./use-session-title";

const TAB = "tab-1";
const SESSION = "session-1";
const actions = () => useChatStore.getState().actions;

async function historyTitle(title: string) {
  await act(async () => {
    backend.rows = [{ sessionId: SESSION, title }];
    for (const notify of backend.listeners) notify();
    await vi.advanceTimersByTimeAsync(HISTORY_COALESCE_MS);
  });
}

function agentTitle(title: string) {
  actions().applyAgentDelta({
    kind: "title_updated",
    agent_id: "agent-1",
    session_id: SESSION,
    title,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  backend.rows = [];
  resetThreadHistoryForTests();
  useChatStore.setState({ sessions: {}, queues: {}, pendingPermissions: {} });
  actions().createSession(TAB, "codex");
});

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.useRealTimers();
});

describe("useSessionTitle", () => {
  it("uses the neutral title before the tab has a session", () => {
    const { result } = renderHook(() => useSessionTitle("unbound-tab"));
    expect(result.current).toBe(UNTITLED_SESSION);
    expect(backend.listeners.size).toBe(0);
  });

  it("shows the first message immediately, even before the agent binds", () => {
    const { result } = renderHook(() => useSessionTitle(TAB));
    expect(result.current).toBe(UNTITLED_SESSION);
    act(() => actions().addMessage(TAB, "user", "Fix the parser"));
    expect(result.current).toBe("Fix the parser");
    act(() => actions().addMessage(TAB, "user", "Now change the tokenizer"));
    expect(result.current).toBe("Fix the parser");
  });

  it("subscribes when the agent binds and uses raw titles only until history arrives", async () => {
    actions().addMessage(TAB, "user", "Fix the parser");
    const { result } = renderHook(() => useSessionTitle(TAB));
    expect(result.current).toBe("Fix the parser");
    expect(backend.listeners.size).toBe(0);
    await act(async () => actions().setAcpBinding(TAB, "agent-1", SESSION, "/tmp/project"));
    expect(backend.listeners.size).toBe(1);
    act(() => agentTitle("Parser error recovery"));
    expect(result.current).toBe("Parser error recovery");
    await historyTitle("My parser work");
    expect(result.current).toBe("My parser work");
  });

  it("replaces the placeholder with the combined title and keeps renames over raw deltas", async () => {
    actions().setAcpBinding(TAB, "agent-1", SESSION, "/tmp/project");
    actions().addMessage(TAB, "user", "Fix the parser");
    const { result } = renderHook(() => useSessionTitle(TAB));
    await act(async () => {});
    expect(result.current).toBe("Fix the parser");

    await historyTitle("Parser error recovery");
    expect(result.current).toBe("Parser error recovery");
    await historyTitle("My parser work");
    act(() => agentTitle("The agent's later title"));
    expect(result.current).toBe("My parser work");
    await historyTitle("My parser work");
    expect(result.current).toBe("My parser work");
  });

  it("preserves a rename made before the first agent title", async () => {
    actions().setAcpBinding(TAB, "agent-1", SESSION, "/tmp/project");
    backend.rows = [{ sessionId: SESSION, title: "My first name" }];
    const { result } = renderHook(() => useSessionTitle(TAB));
    await act(async () => {});
    act(() => {
      actions().addMessage(TAB, "user", "Fix the parser");
      agentTitle("Parser error recovery");
    });
    expect(result.current).toBe("My first name");
  });

  it("shares one history subscription and coalesces updates across title consumers", async () => {
    actions().setAcpBinding(TAB, "agent-1", SESSION, "/tmp/project");
    const header = renderHook(() => useSessionTitle(TAB));
    const remoteControl = renderHook(() => useSessionTitle(TAB));
    await act(async () => {});
    const reads = () => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "threads_history");
    expect(reads()).toHaveLength(1);
    expect(backend.listeners.size).toBe(1);

    await act(async () => {
      backend.rows = [{ sessionId: SESSION, title: "Parser error recovery" }];
      for (let i = 0; i < 5; i++) {
        for (const notify of backend.listeners) notify();
      }
      await vi.advanceTimersByTimeAsync(HISTORY_COALESCE_MS - 1);
    });
    expect(reads()).toHaveLength(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(reads()).toHaveLength(2);
    expect(header.result.current).toBe("Parser error recovery");
    expect(remoteControl.result.current).toBe("Parser error recovery");

    header.unmount();
    expect(backend.listeners.size).toBe(1);
    remoteControl.unmount();
    await act(async () => {});
    expect(backend.listeners.size).toBe(0);
  });

  it("restores the full combined title and never carries it into another session", async () => {
    const title = "My deliberately long session title that must survive reopening unchanged";
    backend.rows = [{ sessionId: SESSION, title }];
    actions().setAcpBinding(TAB, "agent-1", SESSION, "/tmp/project");
    actions().setSessionTitle(TAB, "An old cached title");
    const { result, unmount } = renderHook(() => useSessionTitle(TAB));
    await act(async () => {});
    expect(result.current).toBe(title);
    act(() => {
      actions().clearSession(TAB);
      actions().setAcpBinding(TAB, "agent-2", "session-2", "/tmp/project");
    });
    expect(result.current).toBe(UNTITLED_SESSION);
    unmount();
    await act(async () => {});
    expect(backend.listeners.size).toBe(0);
  });
});
