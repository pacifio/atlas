// @vitest-environment happy-dom
//
// ADR-0001 amendment, Rule 7, at the panel's choke point. The composer refuses
// a send into a session another process is writing, but chips, agent-switch
// handoffs and another agent's `ui_chat` send arrive as `atlas:chat-send` and
// call `ChatPanel.handleSend` directly. This suite pins that every one of
// those is held — kept in the session's queue, never dropped — and that "Send
// anyway" releases it. The queue is Rust's now (the turn controller drains
// it), so "released" means the hold on that queue is lifted and the window
// hands Rust what it held: what the agent then receives is Rust's to send,
// and is covered by `agent_host/steering.rs`'s tests.
//
// The panel's children are stubbed: what is under test is `handleSend` and the
// drain effect, not anything they render.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => [] as string[]);
/** Every other `agents.*` call, as `[name, ...args]`. */
const calls = vi.hoisted(() => [] as unknown[][]);

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("../lib/agents-api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/agents-api")>();
  const agents = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "send"
          ? vi.fn(async (_key: unknown, prompt: string) => {
              sent.push(prompt);
            })
          : vi.fn(async (...args: unknown[]) => {
              calls.push([prop, ...args]);
              return prop === "queueAdd" ? `q-${calls.length}` : {};
            }),
    },
  );
  return { ...real, agents, ensureAgent: vi.fn(async () => ({})), resetAgent: vi.fn() };
});
const Null = vi.hoisted(() => () => null);
vi.mock("./message-input", () => ({ MessageInput: Null }));
vi.mock("./chat-header", () => ({ ChatHeader: Null }));
vi.mock("./agent-update-bar", () => ({ AgentUpdateBar: Null }));
vi.mock("./permission-modal", () => ({ PermissionModal: Null }));
vi.mock("./chat-comments-controller", () => ({ ChatCommentsController: Null }));
vi.mock("./session-elicitation", () => ({ SessionElicitation: Null }));
vi.mock("./transcript", () => ({ Transcript: Null }));

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useChatStore } from "../stores/chat-store";
import { useLiveElsewhereStore } from "../stores/live-elsewhere-store";
import { ChatPanel } from "./chat-panel";

const TAB = "tab-1";
const SESSION = "sess-live";

const queue = () => useChatStore.getState().queues[TAB] ?? [];
/** `sent` holds wire prompts, which carry an appended directive. */
const sentTexts = () => sent.map((p) => p.split("\n")[0]);

const called = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));

beforeEach(() => {
  sent.length = 0;
  calls.length = 0;
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    drafts: {},
    activeSessionId: null,
  });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
  useChatStore.setState((s) => {
    s.sessions[TAB].acpAgentId = "agent-1";
    s.sessions[TAB].acpSessionId = SESSION;
  });
  useLiveElsewhereStore.setState({ live: {}, overridden: {} });
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ChatPanel tabId={TAB} />
    </QueryClientProvider>,
  );
}

function chatSend(text: string) {
  act(() => {
    window.dispatchEvent(new CustomEvent("atlas:chat-send", { detail: { tabId: TAB, text } }));
  });
}

describe("ChatPanel holds every send into a session live elsewhere", () => {
  it("sends an atlas:chat-send normally while the session is not live", async () => {
    mount();
    chatSend("status?");
    await waitFor(() => expect(sentTexts()).toEqual(["status?"]));
  });

  it("holds an atlas:chat-send in the queue, and releases it after Send anyway", async () => {
    useLiveElsewhereStore.getState().actions.setLive([SESSION]);
    mount();

    chatSend("status?");
    // Held, not lost: it sits in the session's queue (and the strip).
    await waitFor(() => expect(queue()).toEqual(["status?"]));
    expect(called("queueAdd").map((args) => args[1])).toEqual(["status?"]);
    expect(called("queuePause")).toContainEqual([expect.anything(), true]);
    expect(sent).toEqual([]);

    act(() => useLiveElsewhereStore.getState().actions.sendAnyway(SESSION));
    // The hold lifts; Rust drains the head (not the window).
    await waitFor(() => expect(called("queuePause")).toContainEqual([expect.anything(), false]));
    expect(sent).toEqual([]);
  });

  it("does not drain the queue at a turn end while held, and drains once the hold lifts", async () => {
    useChatStore.setState((s) => {
      s.sessions[TAB].status = "running";
    });
    useLiveElsewhereStore.getState().actions.setLive([SESSION]);
    mount();
    act(() => {
      useChatStore.getState().actions.enqueueMessage(TAB, "next", []);
    });

    // The turn ends: normally the queue's head goes out now.
    act(() => useChatStore.getState().actions.updateSessionStatus(TAB, "idle"));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    expect(called("queueDrain")).toEqual([]);
    expect(queue()).toEqual(["next"]);

    // The other process goes quiet: the hold lifts, the item the window held
    // goes to the session's queue, and Rust is asked to drain it.
    act(() => useLiveElsewhereStore.getState().actions.setLive([]));
    await waitFor(() => expect(called("queueDrain")).toHaveLength(1));
    expect(called("queueAdd").map((args) => args[1])).toEqual(["next"]);
    expect(called("queuePause")).toContainEqual([expect.anything(), false]);
    expect(sent).toEqual([]);
  });
});
