// @vitest-environment happy-dom
//
// The native agent's model-list refresh (ADR-0007): one call, every native
// session repainted, the per-agent cache rewritten, and a session's own pick
// left alone.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}));

import type { NativeModelsRefresh, SessionModeInfo } from "@/types/agents";
import { loadCachedAcpModels } from "../lib/acp-models-cache";
import { useChatStore } from "./chat-store";
import { useNativeModelsStore } from "./native-models-store";

const LIST: SessionModeInfo[] = [
  { id: "model-a", name: "model-a", description: null },
  { id: "model-b", name: "Model B", description: "second" },
];

function answer(overrides: Partial<NativeModelsRefresh> = {}): NativeModelsRefresh {
  return {
    models: LIST,
    defaultModel: "model-a",
    changed: true,
    reconnected: false,
    ...overrides,
  };
}

function bound(tab: string, agentType: string, acpSession: string) {
  const { actions } = useChatStore.getState();
  actions.createSession(tab, agentType);
  actions.setAcpBinding(tab, "agent-1", acpSession, "/tmp");
}

const session = (tab: string) => useChatStore.getState().sessions[tab];

describe("the native model-list refresh", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
    useChatStore.setState({ sessions: {}, activeSessionId: null });
    useNativeModelsStore.setState({ refreshing: false });
  });

  it("pushes the list to every native session, caches it, and leaves other agents alone", async () => {
    bound("native-1", "cersei", "s-1");
    bound("native-2", "cersei", "s-2");
    bound("claude", "claude-code", "s-3");
    invoke.mockResolvedValueOnce(answer());

    const ok = await useNativeModelsStore.getState().actions.refresh();

    expect(ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith("native_agent_refresh_models");
    expect(session("native-1").acpAvailableModels).toEqual(LIST);
    expect(session("native-2").acpAvailableModels).toEqual(LIST);
    expect(session("claude").acpAvailableModels).toBeUndefined();
    expect(loadCachedAcpModels("cersei")?.availableModels).toEqual(LIST);
    expect(useNativeModelsStore.getState().refreshing).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("never touches a session's current model", async () => {
    bound("native-1", "cersei", "s-1");
    useChatStore.getState().actions.setAcpModels("native-1", "model-b", [LIST[1]]);
    expect(session("native-1").acpCurrentModel).toBe("model-b");
    invoke.mockResolvedValueOnce(answer());

    await useNativeModelsStore.getState().actions.refresh();

    // The list is the agent's; the pick is the session's (acp-models-cache
    // explains why conflating them relabelled every chat).
    expect(session("native-1").acpAvailableModels).toEqual(LIST);
    expect(session("native-1").acpCurrentModel).toBe("model-b");
  });

  it("a failed refresh keeps the last list and says so once", async () => {
    bound("native-1", "cersei", "s-1");
    useChatStore.getState().actions.setAcpModels("native-1", null, [LIST[0]]);
    invoke.mockRejectedValueOnce({ message: "could not reach the gateway", kind: "unknown" });

    const ok = await useNativeModelsStore.getState().actions.refresh();

    expect(ok).toBe(false);
    expect(session("native-1").acpAvailableModels).toEqual([LIST[0]]);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(useNativeModelsStore.getState().refreshing).toBe(false);

    // The org-switch path asks for silence: the composer is already
    // explaining the switch.
    invoke.mockRejectedValueOnce({ message: "could not reach the gateway", kind: "unknown" });
    await useNativeModelsStore.getState().actions.refresh({ silent: true });
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("tells the user when open chats will restart", async () => {
    bound("native-1", "cersei", "s-1");
    invoke.mockResolvedValueOnce(answer({ reconnected: true }));
    await useNativeModelsStore.getState().actions.refresh();
    expect(toastInfo).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent clicks into one call", async () => {
    bound("native-1", "cersei", "s-1");
    let release: (v: NativeModelsRefresh) => void = () => {};
    invoke.mockReturnValueOnce(new Promise<NativeModelsRefresh>((r) => (release = r)));

    const { refresh } = useNativeModelsStore.getState().actions;
    const first = refresh();
    const second = refresh();
    expect(useNativeModelsStore.getState().refreshing).toBe(true);
    release(answer());
    await Promise.all([first, second]);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(session("native-1").acpAvailableModels).toEqual(LIST);
  });
});
