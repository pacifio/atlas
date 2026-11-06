import { beforeEach, describe, expect, it, vi } from "vitest";

const retrieve = vi.fn(async () => ({ prompt: "grounded", sources: [] }));
const stream = vi.fn(async () => {});

vi.mock("../lib/session-chat-api", () => ({
  sessionChat: {
    retrieve: (...a: unknown[]) => retrieve(...(a as [])),
    threadsList: async () => [],
    threadGet: async () => null,
    threadSave: async () => {},
    threadDelete: async () => {},
  },
}));
vi.mock("@/lib/byok/byok-chat", () => ({
  modelchat: { stream: (...a: unknown[]) => stream(...(a as [])), cancel: async () => {} },
  listenModelChat: async () => () => {},
}));

import { useSessionChatStore } from "./session-chat-store";

async function ask(sessionId: string, projectPath: string, remote: string | null) {
  const a = useSessionChatStore.getState().actions;
  await a.open(sessionId, projectPath, null, remote);
  const threadId = useSessionChatStore.getState().activeByAgent[sessionId]!;
  a.setProvider(threadId, "openai");
  a.setModel(threadId, "gpt-5.1");
  await a.send(threadId, "What changed?");
}

describe("session chat grounding source", () => {
  beforeEach(() => {
    retrieve.mockClear();
    stream.mockClear();
  });

  // A Session recorded on another machine opens in the viewer from the server;
  // the chat must be told where to find it too, or Rust answers "session not
  // found" for a Session that is plainly on screen.
  it("passes the Session's server Project to the retrieve call", async () => {
    await ask("as-remote", "", "proj-remote");
    expect(retrieve).toHaveBeenCalledWith("", "as-remote", "What changed?", null, "proj-remote");
    expect(stream).toHaveBeenCalledOnce();
  });

  it("sends no server Project for a local-only Session", async () => {
    await ask("as-local", "C:\\work\\repo", null);
    expect(retrieve).toHaveBeenCalledWith(
      "C:\\work\\repo",
      "as-local",
      "What changed?",
      null,
      null,
    );
  });
});
