// @vitest-environment happy-dom
//
// The session registry: a PTY that outlives React. Tauri is mocked at the
// module boundary — `invoke` records calls and hands back ids, `Channel` is a
// plain object whose `onmessage` the test drives, `listen` is inert.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
);
const channels = vi.hoisted(() => [] as Array<{ onmessage: ((p: ArrayBuffer) => void) | null }>);

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage: ((p: ArrayBuffer) => void) | null = null;
    constructor() {
      channels.push(this);
    }
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));
// xterm is lazy; the tests never enter the alt screen, so it must never load.
vi.mock("@xterm/xterm", () => {
  throw new Error("xterm must not load outside the alt screen");
});
vi.mock("../utils/resolve-font", () => ({
  resolveTerminalFont: () => Promise.resolve("monospace"),
}));
vi.mock("./terminal-notifier", () => ({ createTerminalEventSink: () => () => {} }));

import { terminalSessions } from "./terminal-session";
import { useTerminalStore } from "../stores/terminal-store";

const OSC = (b: string) => `\x1b]${b}\x07`;
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const tick = () => new Promise((r) => setTimeout(r, 0));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));

let ptyCounter = 0;
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd) => {
    if (cmd === "terminal_create") return Promise.resolve(`pty-${++ptyCounter}`);
    if (cmd === "terminal_zsh_dir") return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
  channels.length = 0;
  useTerminalStore.setState({ tabs: {}, busy: {}, pendingCommands: {}, owners: {} });
});

afterEach(() => terminalSessions.closeAll());

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

describe("terminalSessions", () => {
  it("acquire is idempotent and close is once", async () => {
    const key = `k-${Math.random()}`;
    const a = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
    const b = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
    expect(b).toBe(a);
    await tick();
    expect(calls("terminal_create")).toHaveLength(1);
    await a.close();
    await a.close();
    expect(calls("terminal_close")).toHaveLength(1);
  });

  it("parses while hidden without notifying, then publishes once on show", async () => {
    const key = `k-${Math.random()}`;
    const s = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
    await tick();
    const ch = channels[channels.length - 1];
    const listener = vi.fn();
    s.subscribe(listener);
    const before = s.getSnapshot();
    for (let i = 0; i < 20; i++)
      ch.onmessage?.(bytes(OSC("133;A") + OSC("6973;C;ls") + OSC("133;C") + `line ${i}\r\n`));
    await frame();
    await frame();
    // Hidden: the drain ran (acked) but the view saw nothing.
    expect(calls("terminal_ack").length).toBeGreaterThan(0);
    expect(s.getSnapshot().blocks).toBe(before.blocks);
    const notifiedBeforeShow = listener.mock.calls.length;
    s.setVisible(true);
    expect(listener.mock.calls.length).toBeGreaterThan(notifiedBeforeShow);
    expect(s.getSnapshot().blocks.length).toBeGreaterThan(1);
    await s.close();
  });

  it("acks consumed chunks in one call per drain", async () => {
    const key = `k-${Math.random()}`;
    const s = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
    await tick();
    const ch = channels[channels.length - 1];
    for (let i = 0; i < 5; i++) ch.onmessage?.(bytes("x\r\n"));
    await frame();
    await frame();
    const acks = calls("terminal_ack");
    expect(acks).toHaveLength(1);
    expect(acks[0][1]).toMatchObject({ count: 5 });
    await s.close();
  });

  it("reports busy to the store even while hidden, and clears it", async () => {
    const key = `k-${Math.random()}`;
    const s = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
    await tick();
    const ch = channels[channels.length - 1];
    ch.onmessage?.(bytes(OSC("133;A") + OSC("6973;C;sleep 5") + OSC("133;C") + "working\r\n"));
    await frame();
    await frame();
    expect(useTerminalStore.getState().busy[key]).toBe(true);
    ch.onmessage?.(bytes(OSC("133;D;0") + OSC("133;A")));
    await frame();
    await frame();
    expect(useTerminalStore.getState().busy[key]).toBeUndefined();
    await s.close();
  });

  it("never pushes a 2×1 to the PTY and dedupes equal sizes", async () => {
    const key = `k-${Math.random()}`;
    const s = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
    await tick();
    const host = document.createElement("div");
    document.body.appendChild(host);
    s.attach(host);
    // 0×0: deferred.
    Object.defineProperty(host, "clientWidth", { value: 0, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: 0, configurable: true });
    s.requestFit();
    await tick();
    expect(calls("terminal_resize")).toHaveLength(0);
    // A real box: one resize; the same box again: none.
    Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: 600, configurable: true });
    s.requestFit();
    await tick();
    await tick();
    const first = calls("terminal_resize").length;
    expect(first).toBe(1);
    s.requestFit();
    await tick();
    expect(calls("terminal_resize")).toHaveLength(first);
    await s.close();
    host.remove();
  });

  it("bindToStore closes a session whose terminal left the store", async () => {
    const unbind = terminalSessions.bindToStore();
    const st = useTerminalStore.getState();
    st.actions.initTab("tab-x", "ws-1");
    const t = useTerminalStore.getState().tabs["tab-x"];
    const pane = t.root.type === "pane" ? t.root : null;
    const termId = pane!.terminals[0];
    const s = terminalSessions.acquire(termId, { tabId: "tab-x", cwd: "/tmp" });
    await tick();
    expect(terminalSessions.get(termId)).toBe(s);
    useTerminalStore.getState().actions.removeTabs(["tab-x"]);
    await tick();
    expect(terminalSessions.get(termId)).toBeUndefined();
    expect(calls("terminal_close")).toHaveLength(1);
    unbind();
  });

  it("takes the queued command once and sends it after the prompt", async () => {
    const st = useTerminalStore.getState();
    st.actions.initTab("tab-q", "ws-1");
    const t = useTerminalStore.getState().tabs["tab-q"];
    const termId = (t.root as { terminals: string[] }).terminals[0];
    st.actions.setPendingCommand(termId, "claude login");
    const s = terminalSessions.acquire(termId, { tabId: "tab-q", cwd: "/tmp" });
    await tick();
    expect(useTerminalStore.getState().pendingCommands[termId]).toBeUndefined();
    const ch = channels[channels.length - 1];
    ch.onmessage?.(bytes(OSC("133;A")));
    await frame();
    await frame();
    const writes = calls("terminal_write_text");
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ text: "claude login\n" });
    await s.close();
  });
});
