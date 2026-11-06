// @vitest-environment happy-dom
//
// The session registry: a PTY and an xterm that outlive React. Tauri is mocked
// at the module boundary — `invoke` records calls and hands back ids,
// `Channel` is a plain object whose `onmessage` the test drives, `listen` is
// inert. xterm is a fake that records writes and runs the OSC handlers the
// session registers, so shell integration is exercised end to end.

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
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../utils/resolve-font", () => ({
  resolveTerminalFont: () => Promise.resolve("monospace"),
}));
vi.mock("./terminal-notifier", () => ({ createTerminalEventSink: () => () => {} }));

const { terminals, FakeTerminal } = vi.hoisted(() => {
  const terminals: FakeTerminal[] = [];
  class FakeTerminal {
    options: Record<string, unknown>;
    cols: number;
    rows: number;
    unicode = { activeVersion: "" };
    written: string[] = [];
    opened = false;
    private osc = new Map<number, (d: string) => boolean>();
    private dataCb: ((d: string) => void) | null = null;
    parser = {
      registerOscHandler: (id: number, cb: (d: string) => boolean) => {
        this.osc.set(id, cb);
        return { dispose() {} };
      },
    };
    buffer = {
      active: { baseY: 0, cursorY: 0, length: 0, getLine: () => undefined },
      onBufferChange: () => ({ dispose() {} }),
    };
    constructor(opts: Record<string, unknown>) {
      this.options = opts;
      this.cols = Number(opts.cols ?? 80);
      this.rows = Number(opts.rows ?? 24);
      terminals.push(this);
    }
    loadAddon(addon: { activate?: (t: unknown) => void }) {
      addon.activate?.(this);
    }
    open() {
      this.opened = true;
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    write(data: string | Uint8Array, cb?: () => void) {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      this.written.push(text);
      // oxlint-disable-next-line no-control-regex -- OSC framing is control bytes
      for (const m of text.matchAll(/\x1b\](\d+);([^\x07]*)\x07/g)) {
        this.osc.get(Number(m[1]))?.(m[2]);
      }
      if (cb) setTimeout(cb, 0);
    }
    /** Test hook: a keystroke. */
    type(d: string) {
      this.dataCb?.(d);
    }
    onData(cb: (d: string) => void) {
      this.dataCb = cb;
    }
    onBinary() {}
    onBell() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {}
    dispose() {}
    focus() {}
    hasSelection() {
      return false;
    }
    getSelection() {
      return "";
    }
    selectAll() {}
    clearSelection() {}
  }
  return { terminals, FakeTerminal };
});
vi.mock("@xterm/xterm", () => ({ Terminal: FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: 100, rows: 30 };
    }
    fit() {}
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));

// One fake per `new WebglAddon()`, with a per-instance `onContextLoss` close
// enough to the real addon to drive both release paths.
const { webglInstances, FakeWebglAddon } = vi.hoisted(() => {
  class FakeWebglAddon {
    disposed = false;
    private lossCb: (() => void) | null = null;
    onContextLoss(cb: () => void): void {
      this.lossCb = cb;
    }
    dispose(): void {
      this.disposed = true;
    }
    /** Test hook: simulate the addon reporting a context loss. */
    triggerContextLoss(): void {
      this.lossCb?.();
    }
  }
  return { webglInstances: [] as FakeWebglAddon[], FakeWebglAddon };
});
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class extends FakeWebglAddon {
    constructor() {
      super();
      webglInstances.push(this);
    }
  },
}));

import { terminalSessions, liveWebglCount } from "./terminal-session";
import { useTerminalStore } from "../stores/terminal-store";

const OSC = (b: string) => `\x1b]${b}\x07`;
const bytes = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

let ptyCounter = 0;
beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((cmd) => {
    if (cmd === "terminal_create") return Promise.resolve(`pty-${++ptyCounter}`);
    return Promise.resolve(undefined);
  });
  channels.length = 0;
  terminals.length = 0;
  webglInstances.length = 0;
  useTerminalStore.setState({ tabs: {}, busy: {}, pendingCommands: {}, owners: {} });
});

afterEach(() => terminalSessions.closeAll());

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

async function openSession(key: string, visible = true) {
  const s = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 600, configurable: true });
  document.body.appendChild(host);
  s.attach(host);
  s.setVisible(visible);
  await settle();
  return { s, host, ch: channels[channels.length - 1], term: terminals[terminals.length - 1] };
}

describe("terminalSessions", () => {
  it("acquire is idempotent and close is once", async () => {
    const key = `k-${Math.random()}`;
    const a = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
    const b = terminalSessions.acquire(key, { tabId: "t", cwd: "/tmp" });
    expect(b).toBe(a);
    await settle();
    expect(calls("terminal_create")).toHaveLength(1);
    await a.close();
    await a.close();
    expect(calls("terminal_close")).toHaveLength(1);
  });

  it("holds output that arrives before xterm exists, then writes it in order", async () => {
    const s = terminalSessions.acquire(`k-${Math.random()}`, { tabId: "t", cwd: "/tmp" });
    const ch = channels[channels.length - 1];
    ch.onmessage?.(bytes("first\r\n"));
    await settle();
    ch.onmessage?.(bytes("second\r\n"));
    await settle();
    expect(terminals[0].written.join("")).toBe("first\r\nsecond\r\n");
    await s.close();
  });

  it("acks parsed chunks in one call per batch", async () => {
    const { s, ch } = await openSession(`k-${Math.random()}`);
    for (let i = 0; i < 5; i++) ch.onmessage?.(bytes("x\r\n"));
    await settle();
    const acks = calls("terminal_ack");
    expect(acks).toHaveLength(1);
    expect(acks[0][1]).toMatchObject({ count: 5 });
    await s.close();
  });

  it("sends keystrokes straight to the PTY", async () => {
    const { s, term } = await openSession(`k-${Math.random()}`);
    term.type("l");
    term.type("\r");
    expect(calls("terminal_write_text").map((c) => (c[1] as { text: string }).text)).toEqual([
      "l",
      "\r",
    ]);
    await s.close();
  });

  it("reports busy and the running command from shell integration, even hidden", async () => {
    const key = `k-${Math.random()}`;
    const { s, ch } = await openSession(key, false);
    ch.onmessage?.(bytes(OSC("133;A") + OSC("6973;C;sleep 5") + OSC("133;C") + "working\r\n"));
    await settle();
    expect(useTerminalStore.getState().busy[key]).toBe(true);
    expect(s.getSnapshot().command).toBe("sleep 5");
    ch.onmessage?.(bytes(OSC("133;D;0") + OSC("133;A") + OSC("7;file://host/Users/dev/x")));
    await settle();
    expect(useTerminalStore.getState().busy[key]).toBeUndefined();
    expect(s.getSnapshot()).toMatchObject({ command: null, cwd: "/Users/dev/x" });
    await s.close();
  });

  it("never pushes a 2×1 to the PTY and dedupes equal sizes", async () => {
    const s = terminalSessions.acquire(`k-${Math.random()}`, { tabId: "t", cwd: "/tmp" });
    const host = document.createElement("div");
    document.body.appendChild(host);
    // 0×0: deferred.
    Object.defineProperty(host, "clientWidth", { value: 0, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: 0, configurable: true });
    s.attach(host);
    await settle();
    s.requestFit();
    expect(calls("terminal_resize")).toHaveLength(0);
    // A real box: one resize; the same box again: none.
    Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(host, "clientHeight", { value: 600, configurable: true });
    s.requestFit();
    await settle();
    expect(calls("terminal_resize")).toHaveLength(1);
    expect(calls("terminal_resize")[0][1]).toMatchObject({ cols: 100, rows: 30 });
    s.requestFit();
    await settle();
    expect(calls("terminal_resize")).toHaveLength(1);
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
    await settle();
    expect(terminalSessions.get(termId)).toBe(s);
    useTerminalStore.getState().actions.removeTabs(["tab-x"]);
    await settle();
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
    await settle();
    expect(useTerminalStore.getState().pendingCommands[termId]).toBeUndefined();
    channels[channels.length - 1].onmessage?.(bytes(OSC("133;A")));
    await settle();
    const writes = calls("terminal_write_text");
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ text: "claude login\r" });
    await s.close();
  });

  /// ADR-0012: an agent types a line at the prompt; the user presses Enter.
  it("types a queued line without Enter when it was queued typed-only", async () => {
    const st = useTerminalStore.getState();
    st.actions.initTab("tab-t", "ws-1");
    const t = useTerminalStore.getState().tabs["tab-t"];
    const termId = (t.root as { terminals: string[] }).terminals[0];
    st.actions.setPendingCommand(termId, "rm -rf build", { execute: false });
    const s = terminalSessions.acquire(termId, { tabId: "tab-t", cwd: "/tmp" });
    await settle();
    expect(useTerminalStore.getState().pendingTyped[termId]).toBeUndefined();
    channels[channels.length - 1].onmessage?.(bytes(OSC("133;A")));
    await settle();
    const writes = calls("terminal_write_text");
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ text: "rm -rf build" });
    await s.close();
  });
});

// The page-wide WebGL context budget (`MAX_WEBGL`). Only a visible terminal
// holds a context; the session's own release and an addon's `onContextLoss`
// can both fire for one instance, and the second must not decrement the
// counter again — the double-release shape the pixi teardown fix
// (`src/lib/pixi-app.ts`) closed. A regression means the budget undercounts
// live contexts and Atlas hands out more than WKWebView's real cap.
describe("terminal WebGL budget", () => {
  it("a visible terminal holds a context and gives it back when hidden", async () => {
    const a = await openSession(`w-${Math.random()}`);
    expect(liveWebglCount()).toBe(1);
    a.s.setVisible(false);
    expect(webglInstances[0].disposed).toBe(true);
    expect(liveWebglCount()).toBe(0);
    a.s.setVisible(true);
    await settle();
    expect(liveWebglCount()).toBe(1);
    await a.s.close();
    expect(liveWebglCount()).toBe(0);
    a.host.remove();
  });

  it("a stale context-loss for an already-released addon does not re-decrement", async () => {
    const a = await openSession(`a-${Math.random()}`);
    expect(liveWebglCount()).toBe(1);
    const staleAddon = webglInstances[0];
    await a.s.close();
    expect(staleAddon.disposed).toBe(true);
    expect(liveWebglCount()).toBe(0);

    const b = await openSession(`b-${Math.random()}`);
    expect(liveWebglCount()).toBe(1);
    // A's handler fires late, for the addon A already released: the count in
    // scope now belongs to B's live context.
    staleAddon.triggerContextLoss();
    expect(liveWebglCount()).toBe(1);

    await b.s.close();
    expect(liveWebglCount()).toBe(0);
    a.host.remove();
    b.host.remove();
  });

  it("a genuine context loss on a live session releases its own context once", async () => {
    const a = await openSession(`c-${Math.random()}`);
    expect(liveWebglCount()).toBe(1);
    const addon = webglInstances[0];
    addon.triggerContextLoss();
    expect(liveWebglCount()).toBe(0);
    addon.triggerContextLoss();
    expect(liveWebglCount()).toBe(0);
    await a.s.close();
    expect(liveWebglCount()).toBe(0);
    a.host.remove();
  });
});
