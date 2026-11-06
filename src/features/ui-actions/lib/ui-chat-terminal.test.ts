// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The settings store subscribes to config events when it loads.
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";
import { useLiveElsewhereStore } from "@/features/chat/stores/live-elsewhere-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { performUiAction } from "./ui-actions";
import { seedWindow, tab, uiRequest } from "./test-fixtures";
import type { UiActionReply } from "./types";

const result = (reply: UiActionReply) => {
  if (!reply.ok) throw new Error(`expected ok, got: ${reply.error}`);
  return reply.result as Record<string, unknown>;
};
const error = (reply: UiActionReply) => {
  if (reply.ok) throw new Error(`expected a refusal, got ${JSON.stringify(reply.result)}`);
  return reply.error;
};
const act = (tool: string, args: Record<string, unknown>) => performUiAction(uiRequest(tool, args));

/** Every `atlas:chat-*` window event dispatched while `run` runs. */
async function heard(run: () => Promise<unknown>): Promise<Array<[string, unknown]>> {
  const got: Array<[string, unknown]> = [];
  const names = [
    "atlas:chat-focus",
    "atlas:chat-prefill",
    "atlas:chat-insert",
    "atlas:chat-send",
    "atlas:chat-jump",
  ];
  const on = (e: Event) => got.push([e.type, (e as CustomEvent).detail]);
  names.forEach((n) => window.addEventListener(n, on));
  await run();
  names.forEach((n) => window.removeEventListener(n, on));
  return got;
}

beforeEach(() => {
  seedWindow();
  // A second chat in the active project that is not the caller's.
  useLayoutStore.setState({
    tabs: [
      ...useLayoutStore.getState().tabs,
      tab("chat-2", "chat", "main", { title: "Other chat" }),
    ],
    currentViewWsId: "w-1",
    viewsByWs: { "w-2": { tabs: [tab("chat-w", "chat")] } as never },
  });
  useChatStore.setState({
    sessions: {
      "chat-1": { acpSessionId: "sess-1", status: "running", messages: [] },
      "chat-2": { acpSessionId: "sess-2", status: "idle", messages: [] },
    } as never,
    activeSessionId: "chat-1",
  });
  useProjectStore.setState({
    projects: [
      { id: "w-1", name: "atlas", path: "/p" },
      { id: "w-2", name: "website", path: "/w" },
    ] as never,
    activeProjectId: "w-1",
  });
  useLiveElsewhereStore.setState({ live: {}, overridden: {} });
  useTerminalStore.setState({
    tabs: {},
    pendingCommands: {},
    pendingTyped: {},
    pendingFocus: null,
  });
});

describe("ui_chat", () => {
  it("prefills the calling session's own composer by default", async () => {
    const events = await heard(() => act("ui_chat", { op: "prefill", text: "Fix the build" }));
    expect(events).toContainEqual([
      "atlas:chat-prefill",
      { tabId: "chat-1", text: "Fix the build" },
    ]);
    expect(useLayoutStore.getState().activeTabId).toBe("chat-1");
  });

  it("appends with insert, into the tab it activates", async () => {
    const events = await heard(() =>
      act("ui_chat", { op: "insert", tabId: "chat-2", text: "and the tests" }),
    );
    expect(useChatStore.getState().activeSessionId).toBe("chat-2");
    expect(events).toContainEqual(["atlas:chat-insert", { text: "and the tests" }]);
  });

  it("focuses a composer and jumps to a message", async () => {
    const focus = await heard(() => act("ui_chat", { op: "focus", tabId: "chat-2" }));
    expect(focus).toContainEqual(["atlas:chat-focus", { tabId: "chat-2" }]);
    const jump = await heard(() => act("ui_chat", { op: "jump", tabId: "chat-2", index: 3 }));
    expect(jump).toContainEqual(["atlas:chat-jump", { index: 3 }]);
  });

  /// Own-session refusal: the agent may not speak for the user in its own
  /// conversation, nor switch the agent out from under its own running turn.
  it("refuses send and switch_agent on the calling session's own chat", async () => {
    const send = await heard(async () =>
      expect(error(await act("ui_chat", { op: "send", text: "go" }))).toMatch(/prefill/),
    );
    expect(send.filter(([n]) => n === "atlas:chat-send")).toEqual([]);
    expect(error(await act("ui_chat", { op: "switch_agent", agent: "claude-acp" }))).toMatch(
      /your own/,
    );
  });

  /// A stale session entry for the same ACP session (its tab long closed) can
  /// sort before the live one; the refusal must still recognise the live tab.
  it("refuses send on its own chat even when a stale entry shares its session", async () => {
    useChatStore.setState({
      sessions: {
        "chat-old": { acpSessionId: "sess-1", status: "idle", messages: [] },
        "chat-1": { acpSessionId: "sess-1", status: "running", messages: [] },
        "chat-2": { acpSessionId: "sess-2", status: "idle", messages: [] },
      } as never,
    });
    const send = await heard(async () =>
      expect(error(await act("ui_chat", { op: "send", tabId: "chat-1", text: "go" }))).toMatch(
        /prefill/,
      ),
    );
    expect(send.filter(([n]) => n === "atlas:chat-send")).toEqual([]);
    expect(
      error(await act("ui_chat", { op: "switch_agent", tabId: "chat-1", agent: "claude-acp" })),
    ).toMatch(/your own/);
  });

  it("sends into another chat in the active project", async () => {
    const events = await heard(() =>
      act("ui_chat", { op: "send", tabId: "chat-2", text: "status?" }),
    );
    expect(events).toContainEqual(["atlas:chat-send", { tabId: "chat-2", text: "status?" }]);
  });

  it("refuses send into a chat whose session another process is writing, until Send anyway", async () => {
    // ADR-0001 amendment, Rule 7: another agent must not fork a terminal
    // session with no prompt. The refusal names the way out.
    useLiveElsewhereStore.getState().actions.setLive(["sess-2"]);
    const held = await heard(async () =>
      expect(error(await act("ui_chat", { op: "send", tabId: "chat-2", text: "go" }))).toMatch(
        /active in another process.*prefill/,
      ),
    );
    expect(held.filter(([n]) => n === "atlas:chat-send")).toEqual([]);
    // Prefill is still allowed: the user decides.
    expect(result(await act("ui_chat", { op: "prefill", tabId: "chat-2", text: "go" })).op).toBe(
      "prefill",
    );

    useLiveElsewhereStore.getState().actions.sendAnyway("sess-2");
    const sent = await heard(() => act("ui_chat", { op: "send", tabId: "chat-2", text: "go" }));
    expect(sent).toContainEqual(["atlas:chat-send", { tabId: "chat-2", text: "go" }]);
  });

  it("refuses a chat another project owns, naming it", async () => {
    expect(error(await act("ui_chat", { op: "focus", tabId: "chat-w" }))).toMatch(/website/);
  });

  /// "Your own chat" means yours: with none, the agent must name a tab
  /// rather than act on whichever chat the user happens to have focused.
  it("refuses to guess a chat when the caller has none of its own", async () => {
    const stranger = uiRequest("ui_chat", { op: "prefill", text: "hi" }, "sess-elsewhere");
    expect(error(await performUiAction(stranger))).toMatch(/tabId/);
  });

  it("refuses a tab that is not a chat", async () => {
    expect(error(await act("ui_chat", { op: "focus", tabId: "terminal-1" }))).toMatch(/not a chat/);
  });

  it("names what is missing", async () => {
    expect(error(await act("ui_chat", { op: "prefill" }))).toMatch(/text/);
    expect(error(await act("ui_chat", { op: "jump" }))).toMatch(/index/);
    expect(error(await act("ui_chat", { op: "shout" }))).toMatch(/op/);
  });
});

describe("ui_terminal", () => {
  it("opens a terminal tab and focuses it", async () => {
    const r = result(await act("ui_terminal", { op: "open" }));
    const layout = useLayoutStore.getState();
    expect(layout.tabs.find((t) => t.id === r.tabId)?.type).toBe("terminal");
    expect(useTerminalStore.getState().pendingFocus).toMatchObject({ tabId: r.tabId });
  });

  /// The line lands at the prompt; the user runs it.
  it("types a line into a fresh terminal without pressing Enter", async () => {
    const r = result(await act("ui_terminal", { op: "type", text: "bun test" }));
    const terminalId = r.terminalId as string;
    expect(useTerminalStore.getState().pendingCommands[terminalId]).toBe("bun test");
    expect(useTerminalStore.getState().pendingTyped[terminalId]).toBe(true);
    expect(r.executed).toBe(false);
  });

  it("refuses a multi-line text, which would run its first lines", async () => {
    expect(error(await act("ui_terminal", { op: "type", text: "ls\nrm -rf /" }))).toMatch(
      /one line/,
    );
  });

  /// The text reaches the PTY as raw keystrokes, so a control key is a way to
  /// run the line (Ctrl-O, Ctrl-X Ctrl-E, Esc-#) or to act on the shell.
  it.each([
    ["CR", "ls\r"],
    ["CRLF", "ls\r\n"],
    ["Ctrl-O (operate-and-get-next)", "rm -rf build\u000f"],
    ["Ctrl-X Ctrl-E (edit-and-execute)", "rm -rf build\u0018\u0005"],
    ["Esc-# (insert-comment accepts)", "rm -rf build\u001b#"],
    ["Ctrl-D", "\u0004"],
    ["Ctrl-C", "ls\u0003"],
    ["Tab", "ls\t"],
    ["DEL", "ls\u007f"],
    ["NEL", "ls\u0085rm"],
    ["line separator", "ls\u2028rm"],
    ["paragraph separator", "ls\u2029rm"],
    ["bracketed-paste end", "\u001b[201~ls"],
  ])("refuses a %s in the text, and types nothing", async (_name, text) => {
    const before = { ...useTerminalStore.getState().pendingCommands };
    expect(error(await act("ui_terminal", { op: "type", text }))).toMatch(/one line/);
    expect(useTerminalStore.getState().pendingCommands).toEqual(before);
  });

  it("still types printable unicode", async () => {
    const r = result(await act("ui_terminal", { op: "type", text: "echo 'héllo — ✓'" }));
    expect(useTerminalStore.getState().pendingCommands[r.terminalId as string]).toBe(
      "echo 'héllo — ✓'",
    );
  });
});
