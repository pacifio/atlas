// @vitest-environment happy-dom
//
// The in-tab switch rule for a chat that is "busy" only because its first
// message is waiting on a bind that never landed. ⌥/ used to open a NEW tab
// for any `running` status, which left the stuck tab stuck; a start with no
// session has nothing streaming to orphan, so it is switched in place and the
// held message carries over to the new agent's bind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const openAgentChatInNewTab = vi.fn();
vi.mock("./open-agent-session", () => ({
  openAgentChatInNewTab: (...a: unknown[]) => openAgentChatInNewTab(...a),
}));

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    loading: vi.fn((..._a: unknown[]) => "toast-1"),
    dismiss: vi.fn(),
    error: vi.fn(),
  }),
);
vi.mock("sonner", () => ({ toast }));

import { useChatStore } from "../stores/chat-store";
import { useMemorySharingStore } from "@/features/memory/stores/memory-sharing-store";
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import { DEFAULT_SETTINGS, type AppSettings } from "@/features/settings/lib/app-settings";
import {
  CHAT_STOP_EVENT,
  REMEMBER_BEFORE_SWITCH_TIMEOUT_MS,
  REMEMBER_START_TIMEOUT_MS,
  REMEMBER_STOP_GRACE_MS,
  SESSION_HANDOFF_EVENT,
  isStartingOnly,
  isSwitchPending,
  switchAgentForTab,
  type SessionHandoffDetail,
} from "./switch-agent";

const TAB = "tab-1";

describe("switchAgentForTab while starting", () => {
  beforeEach(() => {
    localStorage.clear();
    openAgentChatInNewTab.mockClear();
    useChatStore.setState({ sessions: {}, queues: {}, activeSessionId: null });
    useChatStore.getState().actions.createSession(TAB, "claude-code");
  });

  it("a genuinely busy chat (session bound, turn running) still opens a new tab", () => {
    const { actions } = useChatStore.getState();
    actions.setAcpBinding(TAB, "agent-1", "acp-1", "/tmp");
    actions.updateSessionStatus(TAB, "running");
    switchAgentForTab(TAB, "codex");
    expect(openAgentChatInNewTab).toHaveBeenCalledWith("codex");
    expect(useChatStore.getState().sessions[TAB].agentType).toBe("claude-code");
  });

  it("a chat holding a first message on an unfinished bind switches in place and carries it", () => {
    const { actions } = useChatStore.getState();
    actions.addMessage(TAB, "user", "hello there");
    actions.updateSessionStatus(TAB, "running");
    actions.setPendingSend(TAB, {
      content: "hello there",
      mentions: [],
      attachments: [],
    });
    expect(isStartingOnly(useChatStore.getState().sessions[TAB])).toBe(true);

    switchAgentForTab(TAB, "codex");

    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.agentType).toBe("codex");
    expect(sess.acpSessionId).toBeUndefined();
    expect(sess.status).toBe("running");
    expect(sess.pendingSend?.content).toBe("hello there");
    // Re-recorded as the new session's first bubble, once.
    expect(sess.messages.filter((m) => m.role === "user").map((m) => m.content)).toEqual([
      "hello there",
    ]);
    expect(useChatStore.getState().queues[TAB] ?? []).toEqual([]);
  });

  it("isStartingOnly is false once a session id exists", () => {
    expect(
      isStartingOnly({
        status: "running",
        pendingSend: { content: "x" },
        acpSessionId: "s",
      }),
    ).toBe(false);
    expect(isStartingOnly({ status: "idle", pendingSend: { content: "x" } })).toBe(false);
    expect(isStartingOnly(undefined)).toBe(false);
  });
});

// What switching does to an idle chat with a conversation is the user's
// `agentSwitchBehavior` setting. "reset", the default, is how switching always
// worked: clear the tab and rebind it. "new-tab" keeps the conversation on
// screen and "handoff" carries it to the new agent. An empty chat always flips
// in place, and a running one always gets a new tab.
describe("switchAgentForTab on an idle chat", () => {
  const behave = (agentSwitchBehavior: AppSettings["agentSwitchBehavior"]) =>
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, agentSwitchBehavior } });

  const converse = () => {
    const { actions } = useChatStore.getState();
    actions.setAcpBinding(TAB, "agent-1", "acp-1", "/repo");
    actions.addMessage(TAB, "user", "what does this repo do?");
    actions.addMessage(TAB, "assistant", "It scrapes hotel prices.");
    actions.setSessionTitle(TAB, "What does this repo do");
  };

  const handoffs: SessionHandoffDetail[] = [];
  const onHandoff = (e: Event) => handoffs.push((e as CustomEvent<SessionHandoffDetail>).detail);

  beforeEach(() => {
    localStorage.clear();
    openAgentChatInNewTab.mockClear();
    handoffs.length = 0;
    window.addEventListener(SESSION_HANDOFF_EVENT, onHandoff);
    useChatStore.setState({ sessions: {}, queues: {}, activeSessionId: null });
    useChatStore.getState().actions.createSession(TAB, "codex");
    behave("reset");
  });
  afterEach(() => window.removeEventListener(SESSION_HANDOFF_EVENT, onHandoff));

  it("keeps the conversation and opens the new agent in a new tab", () => {
    behave("new-tab");
    converse();

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).toHaveBeenCalledWith("claude-code");
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.agentType).toBe("codex");
    expect(sess.acpSessionId).toBe("acp-1");
    expect(sess.messages.map((m) => m.content)).toEqual([
      "what does this repo do?",
      "It scrapes hotel prices.",
    ]);
    expect(handoffs).toEqual([]);
  });

  it("hands off in place: same tab, new agent, the conversation attached as a chip", () => {
    behave("handoff");
    converse();

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.agentType).toBe("claude-code");
    expect(sess.acpSessionId).toBeUndefined();
    expect(sess.messages).toEqual([]);
    expect(handoffs).toEqual([
      {
        tabId: TAB,
        mention: {
          kind: "past_session",
          id: "acp-1",
          displayName: "What does this repo do",
          sessionId: "acp-1",
          sessionTitle: "What does this repo do",
          cwd: "/repo",
        },
      },
    ]);
  });

  it("falls back to a new tab when a handoff has no recorded session to attach", () => {
    behave("handoff");
    useChatStore.getState().actions.addMessage(TAB, "user", "never bound");

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).toHaveBeenCalledWith("claude-code");
    expect(useChatStore.getState().sessions[TAB].agentType).toBe("codex");
    expect(handoffs).toEqual([]);
  });

  it("resets in place by default, attaching nothing", () => {
    expect(DEFAULT_SETTINGS.agentSwitchBehavior).toBe("reset");
    converse();

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.agentType).toBe("claude-code");
    expect(sess.messages).toEqual([]);
    expect(handoffs).toEqual([]);
  });

  it.each(["new-tab", "handoff", "reset"] as const)("flips an empty chat in place (%s)", (b) => {
    behave(b);

    switchAgentForTab(TAB, "claude-code");

    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions[TAB].agentType).toBe("claude-code");
    expect(handoffs).toEqual([]);
  });

  it.each(["new-tab", "handoff", "reset"] as const)(
    "still opens a new tab for a running chat (%s)",
    (b) => {
      behave(b);
      converse();
      useChatStore.getState().actions.updateSessionStatus(TAB, "running");

      switchAgentForTab(TAB, "claude-code");

      expect(openAgentChatInNewTab).toHaveBeenCalledWith("claude-code");
      expect(useChatStore.getState().sessions[TAB].agentType).toBe("codex");
      expect(handoffs).toEqual([]);
    },
  );
});

// `rememberBeforeSwitch`: when the agent being left advertises `/remember`, it
// is sent that command first, and the switch runs once that turn has ended
// (or the user stops waiting) — as `agentSwitchBehavior` says.
describe("switchAgentForTab with rememberBeforeSwitch", () => {
  const sends: { tabId: string; text: string }[] = [];
  const onSend = (e: Event) =>
    sends.push((e as CustomEvent<{ tabId: string; text: string }>).detail);
  const stops: string[] = [];
  /** What the chat panel's Stop does, as far as the store sees: the turn ends
   *  cancelled. `false` leaves the turn running, as a wedged agent would. */
  let stopWorks = true;
  const onStop = (e: Event) => {
    const { tabId } = (e as CustomEvent<{ tabId: string }>).detail;
    stops.push(tabId);
    if (stopWorks) useChatStore.getState().actions.updateSessionStatus(tabId, "idle");
  };
  const handoffs: SessionHandoffDetail[] = [];
  const onHandoff = (e: Event) => handoffs.push((e as CustomEvent<SessionHandoffDetail>).detail);

  const setup = (
    rememberBeforeSwitch = true,
    agentSwitchBehavior: AppSettings["agentSwitchBehavior"] = "reset",
  ) =>
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, rememberBeforeSwitch, agentSwitchBehavior },
    });
  /** A bound conversation whose agent advertises `commands`. */
  const converse = (tabId = TAB, commands: string[] = ["review", "remember"]) => {
    const { actions } = useChatStore.getState();
    actions.setAcpBinding(tabId, "agent-1", `acp-${tabId}`, "/repo");
    actions.addMessage(tabId, "user", "what does this repo do?");
    actions.addMessage(tabId, "assistant", "It scrapes hotel prices.");
    useChatStore.setState((s) => {
      s.sessions[tabId].availableCommands = commands.map((name) => ({ name, description: "" }));
    });
  };
  const status = (s: "running" | "idle" | "error") =>
    useChatStore.getState().actions.updateSessionStatus(TAB, s);
  const agent = () => useChatStore.getState().sessions[TAB].agentType;
  const clickSwitchNow = () =>
    (
      toast.loading.mock.calls[0] as unknown as [string, { action: { onClick: () => void } }]
    )[1].action.onClick();

  beforeEach(() => {
    localStorage.clear();
    openAgentChatInNewTab.mockClear();
    toast.mockClear();
    toast.loading.mockClear();
    toast.dismiss.mockClear();
    toast.error.mockClear();
    sends.length = 0;
    stops.length = 0;
    handoffs.length = 0;
    stopWorks = true;
    window.addEventListener("atlas:chat-send", onSend);
    window.addEventListener(CHAT_STOP_EVENT, onStop);
    window.addEventListener(SESSION_HANDOFF_EVENT, onHandoff);
    useChatStore.setState({ sessions: {}, queues: {}, activeSessionId: null });
    useChatStore.getState().actions.createSession(TAB, "codex");
  });
  afterEach(() => {
    vi.useRealTimers();
    window.removeEventListener("atlas:chat-send", onSend);
    window.removeEventListener(CHAT_STOP_EVENT, onStop);
    window.removeEventListener(SESSION_HANDOFF_EVENT, onHandoff);
    useMemorySharingStore.setState({ enabled: true });
  });

  it("is off by default", () => {
    expect(DEFAULT_SETTINGS.rememberBeforeSwitch).toBe(false);
  });

  it("sends /remember as a plain message, and switches after that turn ends", async () => {
    setup();
    converse();

    switchAgentForTab(TAB, "claude-code");

    expect(sends).toEqual([{ tabId: TAB, text: "/remember" }]);
    expect(toast.loading).toHaveBeenCalledOnce();
    expect(agent()).toBe("codex");

    status("running");
    await Promise.resolve();
    expect(agent()).toBe("codex");

    status("idle");
    await vi.waitFor(() => expect(agent()).toBe("claude-code"));
    expect(toast.dismiss).toHaveBeenCalledWith("toast-1");
    expect(toast.error).not.toHaveBeenCalled();
    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    expect(sends).toHaveLength(1);
  });

  it("asks only an agent that advertises /remember, and nothing else decides", () => {
    // The Memory panel's sharing store is not consulted: it holds whichever
    // project that panel last showed, not this tab's.
    useMemorySharingStore.setState({ enabled: false });
    setup();
    converse(TAB, ["review"]);
    switchAgentForTab(TAB, "claude-code");
    expect(sends).toEqual([]);
    expect(agent()).toBe("claude-code");

    useChatStore.getState().actions.createSession("tab-2", "codex");
    converse("tab-2");
    switchAgentForTab("tab-2", "claude-code");
    expect(sends).toEqual([{ tabId: "tab-2", text: "/remember" }]);
  });

  it("does nothing extra when off, or for an empty chat", () => {
    setup(false);
    converse();
    switchAgentForTab(TAB, "claude-code");
    expect(sends).toEqual([]);
    expect(agent()).toBe("claude-code");

    useChatStore.getState().actions.createSession("tab-2", "codex");
    setup(true);
    switchAgentForTab("tab-2", "claude-code");
    expect(sends).toEqual([]);
    expect(useChatStore.getState().sessions["tab-2"].agentType).toBe("claude-code");
  });

  it("a second pick during the save replaces the pending switch", async () => {
    setup();
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    // Busy now — without the pending record this pick would open a new tab
    // and the deferred switch would still fire.
    switchAgentForTab(TAB, "atlas-agent");

    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    expect(toast.loading).toHaveBeenLastCalledWith(
      expect.stringContaining("Atlas Agent"),
      expect.objectContaining({ id: "toast-1" }),
    );

    status("idle");
    await vi.waitFor(() => expect(agent()).toBe("atlas-agent"));
    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    expect(sends).toHaveLength(1);
  });

  it("picking the agent the tab is on during the save calls the switch off", async () => {
    setup();
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    switchAgentForTab(TAB, "codex");
    await vi.waitFor(() => expect(toast.dismiss).toHaveBeenCalledWith("toast-1"));

    status("idle");
    await Promise.resolve();
    expect(agent()).toBe("codex");
    expect(openAgentChatInNewTab).not.toHaveBeenCalled();

    // The record is gone: the next pick is an ordinary one again.
    switchAgentForTab(TAB, "claude-code");
    expect(sends).toHaveLength(2);
  });

  it("'Switch now' with new-tab leaves the save running and opens a new tab", async () => {
    setup(true, "new-tab");
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    clickSwitchNow();

    await vi.waitFor(() => expect(openAgentChatInNewTab).toHaveBeenCalledWith("claude-code"));
    expect(stops).toEqual([]);
    expect(agent()).toBe("codex");
  });

  it("'Switch now' with reset stops the save and switches in place", async () => {
    setup(true, "reset");
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    clickSwitchNow();

    await vi.waitFor(() => expect(agent()).toBe("claude-code"));
    expect(stops).toEqual([TAB]);
    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions[TAB].messages).toEqual([]);
  });

  it("'Switch now' with handoff stops the save and hands off without it", async () => {
    setup(true, "handoff");
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    clickSwitchNow();

    await vi.waitFor(() => expect(agent()).toBe("claude-code"));
    expect(stops).toEqual([TAB]);
    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].mention).toMatchObject({ sessionId: `acp-${TAB}`, endBeforeRemember: true });
  });

  it("a handoff after a finished save leaves the save out of the transcript", async () => {
    setup(true, "handoff");
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    status("idle");

    await vi.waitFor(() => expect(handoffs).toHaveLength(1));
    expect(handoffs[0].mention.endBeforeRemember).toBe(true);
    expect(stops).toEqual([]);
  });

  it("a plain handoff, with no save before it, attaches the whole transcript", () => {
    setup(false, "handoff");
    converse();

    switchAgentForTab(TAB, "claude-code");

    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].mention.endBeforeRemember).toBeUndefined();
  });

  it("a stop that does not take falls back to a new tab, and says so", async () => {
    vi.useFakeTimers();
    stopWorks = false;
    setup(true, "reset");
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    clickSwitchNow();
    await vi.advanceTimersByTimeAsync(REMEMBER_STOP_GRACE_MS);

    expect(stops).toEqual([TAB]);
    expect(openAgentChatInNewTab).toHaveBeenCalledWith("claude-code");
    expect(agent()).toBe("codex");
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("new tab"));
  });

  it("a timed-out save tells the user, then switches as configured", async () => {
    vi.useFakeTimers();
    setup(true, "reset");
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    await vi.advanceTimersByTimeAsync(REMEMBER_BEFORE_SWITCH_TIMEOUT_MS);

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("did not finish saving"));
    expect(stops).toEqual([TAB]);
    expect(agent()).toBe("claude-code");
    expect(openAgentChatInNewTab).not.toHaveBeenCalled();
  });

  it("a failed save tells the user before switching", async () => {
    setup(true, "reset");
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    expect(toast.error).not.toHaveBeenCalled();
    status("error");

    await vi.waitFor(() => expect(agent()).toBe("claude-code"));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("could not save to memory"));
    const dismissed = toast.dismiss.mock.invocationCallOrder;
    expect(toast.error.mock.invocationCallOrder[0]).toBeLessThan(dismissed[dismissed.length - 1]);
  });

  it("a /remember that never starts tells the user, and hands off the whole transcript", async () => {
    vi.useFakeTimers();
    setup(true, "handoff");
    converse();

    switchAgentForTab(TAB, "claude-code");
    // Nobody picks the send up: the status never leaves idle.
    await vi.advanceTimersByTimeAsync(REMEMBER_START_TIMEOUT_MS);

    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Could not ask"));
    expect(agent()).toBe("claude-code");
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0].mention.endBeforeRemember).toBeUndefined();
  });

  it("skips the switch if the tab was switched by other means while waiting", async () => {
    setup();
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    useChatStore.getState().actions.switchChatAgent(TAB, "atlas-agent");
    status("idle");
    await vi.waitFor(() => expect(toast.dismiss).toHaveBeenCalled());
    expect(agent()).toBe("atlas-agent");
  });

  // The chat panel does not drain a queue while a switch is pending
  // (`isSwitchPending`); clearing the session for an in-place switch used to
  // drop whatever the user typed during the save.
  it("a message typed during the save goes to the new agent when switching in place", async () => {
    setup();
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    expect(isSwitchPending(TAB)).toBe(true);
    useChatStore.getState().actions.enqueueMessage(TAB, "now add a retry");
    status("idle");
    await vi.waitFor(() => expect(agent()).toBe("claude-code"));

    expect(isSwitchPending(TAB)).toBe(false);
    // Held for the new bind, like a first message sent while starting.
    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.pendingSend).toEqual({ content: "now add a retry", mentions: [] });
    expect(sess.messages.map((m) => m.content)).toEqual(["now add a retry"]);
    expect(useChatStore.getState().queues[TAB] ?? []).toEqual([]);
    expect(sends).toEqual([{ tabId: TAB, text: "/remember" }]);
  });

  it("with handoff, the first message typed during the save carries the conversation", async () => {
    setup(true, "handoff");
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    const { actions } = useChatStore.getState();
    actions.enqueueMessage(TAB, "now add a retry");
    actions.enqueueMessage(TAB, "and a test");
    status("idle");
    await vi.waitFor(() => expect(agent()).toBe("claude-code"));

    const sess = useChatStore.getState().sessions[TAB];
    expect(sess.pendingSend?.content).toBe("now add a retry");
    expect(sess.pendingSend?.mentions).toEqual([
      expect.objectContaining({
        kind: "past_session",
        sessionId: `acp-${TAB}`,
        endBeforeRemember: true,
      }),
    ]);
    expect(useChatStore.getState().queues[TAB]).toEqual(["and a test"]);
    // Not also left in the composer, where it would go out a second time.
    expect(handoffs).toEqual([]);
  });

  it("a message typed during the save stays with the old tab under new-tab, and is sent", async () => {
    setup(true, "new-tab");
    converse();

    switchAgentForTab(TAB, "claude-code");
    status("running");
    useChatStore.getState().actions.enqueueMessage(TAB, "now add a retry");
    status("idle");
    await vi.waitFor(() => expect(openAgentChatInNewTab).toHaveBeenCalledWith("claude-code"));

    expect(agent()).toBe("codex");
    expect(sends).toEqual([
      { tabId: TAB, text: "/remember" },
      { tabId: TAB, text: "now add a retry" },
    ]);
    expect(useChatStore.getState().queues[TAB] ?? []).toEqual([]);
  });
});
