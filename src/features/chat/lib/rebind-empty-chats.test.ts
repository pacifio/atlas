// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "@/features/chat/stores/chat-store";
import { rebindEmptyChats } from "./rebind-empty-chats";

const bind = (tab: string) =>
  useChatStore.getState().actions.setAcpBinding(tab, "agent-1", `acp-${tab}`, "/proj");
const sessionOf = (tab: string) => useChatStore.getState().sessions[tab];

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  const { actions } = useChatStore.getState();
  for (const tab of ["empty", "talked", "busy"]) {
    actions.createSession(tab, "claude-code");
    bind(tab);
  }
  actions.addMessage("talked", "user", "hi");
  actions.updateSessionStatus("busy", "running");
});

describe("rebindEmptyChats", () => {
  it("drops only an empty, idle chat's session, so its panel binds a fresh one", () => {
    rebindEmptyChats();
    expect(sessionOf("empty").acpSessionId).toBeUndefined();
    expect(sessionOf("talked").acpSessionId).toBe("acp-talked");
    expect(sessionOf("talked").messages).toHaveLength(1);
    expect(sessionOf("busy").acpSessionId).toBe("acp-busy");
  });
});
