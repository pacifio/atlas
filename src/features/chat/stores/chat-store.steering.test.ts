// @vitest-environment happy-dom
//
// Universal RC groundwork, the window's half: a prompt is a `user_message`
// delta now (whoever sent it), the turn queue is Rust's and arrives as
// `queue_changed`, a hold arrives as `hold_changed`, and a snapshot hands back
// open permission prompts. The store must draw a prompt exactly once — the
// window's own optimistic row is adopted, never doubled.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import type { AgentDelta, SessionMessage } from "@/types/agents";
import { useChatStore } from "./chat-store";

const TAB = "tab-1";
const SESSION = "sess-1";
const AGENT = "agent-1";

const route = { agent_id: AGENT, session_id: SESSION };

function userMessage(content: string): SessionMessage {
  return {
    id: `msg-${content}`,
    role: "user",
    mode: "text",
    content,
    tool_calls: [],
    timestamp: "2026-01-02T03:04:05Z",
  };
}

const apply = (delta: AgentDelta) => useChatStore.getState().actions.applyAgentDelta(delta);
const session = () => useChatStore.getState().sessions[TAB];
const userRows = () => session().messages.filter((m) => m.role === "user");

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    queueIds: {},
    activeSessionId: null,
  });
  const { actions } = useChatStore.getState();
  actions.createSession(TAB, "atlas-agent");
  actions.setAcpBinding(TAB, AGENT, SESSION, "/tmp/project");
});

describe("hold_changed across a rebind", () => {
  it("a bind onto a different session forgets the old session's hold", () => {
    apply({ kind: "hold_changed", ...route, seq: 1, held: true });
    expect(session().held).toBe(true);
    // Same session re-bound (a reload): the hold stays.
    useChatStore.getState().actions.setAcpBinding(TAB, AGENT, SESSION, "/tmp/project");
    expect(session().held).toBe(true);
    // A fresh session (the agent died and resume failed): the room held the
    // OLD session; carrying its hold over would skip the stop-confirm on
    // close and leave a busy agent running headless.
    useChatStore.getState().actions.setAcpBinding(TAB, AGENT, "sess-2", "/tmp/project");
    expect(session().held).toBeUndefined();
  });
});

describe("user_message", () => {
  it("adopts the window's own optimistic row by its client id", () => {
    const id = useChatStore.getState().actions.addMessage(TAB, "user", "fix the build");
    expect(id).toBeTruthy();

    apply({
      kind: "user_message",
      ...route,
      seq: 3,
      message: userMessage("fix the build"),
      origin: { kind: "local" },
      client_message_id: id,
    });

    expect(userRows()).toHaveLength(1);
    expect(session().userMessageCount).toBe(1);
  });

  it("draws a prompt this window never drew — a remote driver's — once, titled", () => {
    apply({
      kind: "user_message",
      ...route,
      message: userMessage("deploy staging"),
      origin: { kind: "remote", id: "guest:ab12", name: "Sam" },
    });

    expect(userRows()).toHaveLength(1);
    expect(userRows()[0].content).toBe("deploy staging");
    expect(userRows()[0].origin).toEqual({ kind: "remote", id: "guest:ab12", name: "Sam" });
    expect(session().title).toBe("deploy staging");
    expect(session().firstUserContent).toBe("deploy staging");
  });

  it("a drained queue item is drawn with its hidden directive kept out of the title", () => {
    apply({
      kind: "user_message",
      ...route,
      message: userMessage("and the tests\n\n═══ Atlas next-steps ═══\nWhen you have finished…"),
      origin: { kind: "local" },
    });
    expect(session().title).toBe("and the tests");
  });
});

describe("queue_changed", () => {
  it("mirrors Rust's queue, keeping items the window still holds locally after it", () => {
    const { actions } = useChatStore.getState();
    actions.enqueueMessage(TAB, "typed before the bind", []); // local
    actions.enqueueMessage(TAB, "on its way", [], "pending:1");

    apply({
      kind: "queue_changed",
      ...route,
      queue: [
        { id: "q-1", text: "on its way", origin: { kind: "local" } },
        { id: "q-2", text: "from the phone", origin: { kind: "remote", id: "user-7" } },
      ],
    });

    const s = useChatStore.getState();
    expect(s.queues[TAB]).toEqual(["on its way", "from the phone", "typed before the bind"]);
    expect(s.queueIds[TAB]).toEqual(["q-1", "q-2", null]);
  });

  it("an empty queue clears the strip", () => {
    useChatStore.getState().actions.enqueueMessage(TAB, "x", [], "q-9");
    apply({ kind: "queue_changed", ...route, queue: [] });
    expect(useChatStore.getState().queues[TAB]).toBeUndefined();
    expect(useChatStore.getState().queueIds[TAB]).toBeUndefined();
  });
});

describe("hold_changed and the snapshot's live state", () => {
  it("records the hold", () => {
    apply({ kind: "hold_changed", ...route, held: true });
    expect(session().held).toBe(true);
    apply({ kind: "hold_changed", ...route, held: false });
    expect(session().held).toBeUndefined();
  });

  it("a reopened session gets its open permission prompt, queue and hold back", () => {
    useChatStore.getState().actions.hydrateSessionSnapshot(TAB, "waiting", [], undefined, {
      agentId: AGENT,
      pendingPermissions: [
        {
          request_id: "req-1",
          tool_call: { toolCallId: "call-1" },
          options: [{ optionId: "allow_once" }],
        },
      ],
      pendingElicitation: {
        request_id: "eli-1",
        mode: "form",
        message: "Which environment?",
      },
      queue: [{ id: "q-1", text: "next", origin: { kind: "local" } }],
      held: true,
    });

    const s = useChatStore.getState();
    expect(s.pendingPermissions[SESSION]?.map((p) => p.requestId)).toEqual(["req-1"]);
    expect(s.sessions[TAB].pendingElicitation?.requestId).toBe("eli-1");
    expect(s.queues[TAB]).toEqual(["next"]);
    expect(s.sessions[TAB].held).toBe(true);

    // Hydrating again (a metadata refresh) does not stack the same prompt.
    useChatStore.getState().actions.hydrateSessionSnapshot(TAB, "waiting", [], undefined, {
      agentId: AGENT,
      pendingPermissions: [{ request_id: "req-1", tool_call: {}, options: [] }],
    });
    expect(useChatStore.getState().pendingPermissions[SESSION]).toHaveLength(1);
  });
});
