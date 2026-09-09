/**
 * A terminal session that outlives React.
 *
 * Everything that used to live inside one `useEffect` in `BlockTerminal` — the
 * PTY, its byte channel, the block parser, the interactive xterm surface — is
 * owned here, in a module-level registry keyed by the layout terminal id. React
 * components ATTACH a view to a session and detach again; nothing about a
 * remount, a column move, a pane split or a workspace switch touches the shell.
 *
 * What this buys, concretely:
 *  - a build running in workspace A keeps running while you look at B (the
 *    panel unmounts; the session does not);
 *  - closing a split column or moving a tab no longer respawns its shells;
 *  - StrictMode's mount → unmount → mount no longer creates two PTYs;
 *  - a HIDDEN session (inactive tab, inactive terminal in a pane, background
 *    workspace) does no React work at all: the parser keeps the block model
 *    correct, `busy` keeps flowing to the tab strip, and the view is rebuilt
 *    once when it becomes visible again.
 *
 * xterm is LAZY. The interactive surface exists only while an alternate-screen
 * app is on screen (vim, htop…); the block UI owns everything else. In the
 * common case a dozen terminals hold zero xterm instances and zero WebGL
 * contexts. When xterm does exist its context comes out of a page-wide budget
 * (`MAX_WEBGL`), because WKWebView caps contexts and silently degrades the
 * ones past the cap.
 *
 * Lifetime: `terminalSessions.bindToStore()` closes a session the moment its
 * terminal id disappears from `useTerminalStore` — the one seam that covers
 * every close path (terminal, pane, tab, workspace discard).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import { isScrollHot } from "@/lib/scroll-hot";
import { BlockStreamParser, type TerminalBlock, type TerminalEvent } from "./block-parser";
import { createTerminalEventSink } from "./terminal-notifier";
import { createTerminalKeymap } from "./terminal-keymap";
import { createPathLinkProvider } from "./path-link-provider";
import { resolveTerminalFont } from "../utils/resolve-font";
import { perfBegin, perfBlockDone, perfBytes } from "./term-perf";
import { collectPanes, useTerminalStore } from "../stores/terminal-store";

// ── Public shapes ──────────────────────────────────────────────────────────

export interface SessionSnapshot {
  blocks: TerminalBlock[];
  altScreen: boolean;
  appCursorKeys: boolean;
  /** The running program put the tty in raw mode — see `TtyModeProbe` (Rust). */
  rawMode: boolean;
  cwd: string;
  /** xterm exists and is open — the alt-screen surface can take focus. */
  surfaceReady: boolean;
  /** The shell process ended (PTY EOF). */
  exited: boolean;
  ptyId: string | null;
  /** Bumped when a ⌘F arrives from the keybinding layer. */
  searchRequest: number;
}

export interface AcquireOptions {
  tabId: string;
  cwd: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Frame budget for consuming queued PTY chunks. */
const DRAIN_BUDGET_MS = 8;
const DRAIN_BYTE_CAP = 2 * 1024 * 1024;
/** Chunks queue up while rAF is paused (window not frontmost); this keeps the
 *  PTY draining so a background build never stalls on a closed window. */
const DRAIN_BACKSTOP_MS = 250;
/** Text for a hidden or not-yet-created xterm is held up to this much. */
const XTERM_RING_CAP = 512 * 1024;
/** xterm is disposed this long after the alt screen is left. */
const XTERM_LINGER_MS = 30_000;
/** WKWebView caps WebGL contexts around 16 per page; leave headroom. */
const MAX_WEBGL = 8;
/** Trailing coalesce for `terminal_resize` during a drag. */
const RESIZE_COALESCE_MS = 40;
/** Below this the box is not a terminal yet (a hidden 0×0 fits to 2×1). */
const MIN_COLS = 10;
const MIN_ROWS = 3;

// Interactive root-shell invocations (no trailing command). These start a root
// shell that WON'T load Atlas's zsh integration (sudo strips the env), so we
// relaunch them through our integration ZDOTDIR — otherwise command blocks /
// prompt markers break as root ("sudo -s behaves weirdly").
const SUDO_SHELL_RE = /^sudo\s+(?:-s|-i|su(?:\s+-l?|\s+-)?)\s*$/;

// ANSI palette for the interactive xterm surface — matches the block renderer
// so blocks and the live surface look the same.
const XTERM_THEME = {
  background: "#000000",
  foreground: "#cccccc",
  cursor: "#b3b3b3",
  selectionBackground: "rgba(97,175,239,0.35)",
  selectionInactiveBackground: "rgba(255,255,255,0.16)",
  black: "#1a1a1a",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#cccccc",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.4;

// ── Module state (survives HMR via globalThis) ─────────────────────────────

interface Registry {
  sessions: Map<string, TerminalSession>;
  byPty: Map<string, TerminalSession>;
  webglCount: number;
  listenersStarted: boolean;
  storeBound: boolean;
  zshDir: string | null | undefined;
  cell: { w: number; h: number } | null;
}
const g = globalThis as unknown as { __atlasTerminalSessions?: Registry };
const reg: Registry = (g.__atlasTerminalSessions ??= {
  sessions: new Map(),
  byPty: new Map(),
  webglCount: 0,
  listenersStarted: false,
  storeBound: false,
  zshDir: undefined,
  cell: null,
});

function startGlobalListeners(): void {
  if (reg.listenersStarted) return;
  reg.listenersStarted = true;
  void listen<{ id: string; raw: boolean }>("terminal-mode", (evt) => {
    reg.byPty.get(evt.payload.id)?.onRawMode(evt.payload.raw);
  });
  void listen<{ id: string }>("terminal-exit", (evt) => {
    reg.byPty.get(evt.payload.id)?.onExited();
  });
  void invoke<string | null>("terminal_zsh_dir")
    .then((d) => {
      reg.zshDir = d;
    })
    .catch(() => {
      reg.zshDir = null;
    });
}

/**
 * Character cell size for the terminal font, measured once. Used to size the
 * PTY BEFORE xterm exists (xterm is lazy); once xterm is up, its own fit
 * addon takes over and any small disagreement is corrected by one resize.
 */
async function cellSize(): Promise<{ w: number; h: number }> {
  if (reg.cell) return reg.cell;
  const fontFamily = await resolveTerminalFont(FONT_SIZE);
  const span = document.createElement("span");
  span.textContent = "W".repeat(20);
  span.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${FONT_SIZE}px ${fontFamily};line-height:${LINE_HEIGHT}`;
  document.body.appendChild(span);
  const rect = span.getBoundingClientRect();
  span.remove();
  const w = rect.width > 0 ? rect.width / 20 : FONT_SIZE * 0.6;
  const h = Math.ceil(FONT_SIZE * LINE_HEIGHT);
  reg.cell = { w, h };
  return reg.cell;
}

// ── Session ────────────────────────────────────────────────────────────────

export class TerminalSession {
  readonly key: string;
  readonly tabId: string;
  /** The element xterm opens into. Views append it; it is never recreated. */
  readonly surfaceEl: HTMLDivElement;

  private readonly parser: BlockStreamParser;
  private readonly decoder = new TextDecoder();
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionSnapshot;

  private ptyId: string | null = null;
  private closed = false;
  private readonly pendingChunks: (ArrayBuffer | number[])[] = [];
  private drainRaf = 0;
  private drainBackstop = 0;
  private queuedCommand: string | null = null;
  private queuedFloor = 0;

  private host: HTMLElement | null = null;
  private visible = false;
  private dirtyWhileHidden = false;
  private busy = false;

  private xterm: Terminal | null = null;
  private fit: FitAddon | null = null;
  private webgl: WebglAddon | null = null;
  private xtermCreating = false;
  private xtermRing: string[] = [];
  private xtermRingBytes = 0;
  private xtermRingOverflow = false;
  private xtermLinger = 0;

  private lastSize: { cols: number; rows: number } | null = null;
  private resizeTimer = 0;
  private fitPending = false;

  // Dev perf bookkeeping (no-ops in production).
  private flushEnd: (() => void) | null = null;
  private perfClosedFor = -1;

  constructor(key: string, opts: AcquireOptions) {
    this.key = key;
    this.tabId = opts.tabId;
    this.surfaceEl = document.createElement("div");
    this.surfaceEl.className = "absolute inset-0";

    const notify = createTerminalEventSink({ terminalId: key, tabId: opts.tabId });
    this.parser = new BlockStreamParser(
      opts.cwd,
      () => this.onParserChange(),
      (e) => {
        this.onParserEvent(e);
        notify(e);
      },
    );
    this.parser.setXtermSink((t) => this.feedXterm(t));
    this.snapshot = {
      blocks: this.parser.blocks,
      altScreen: false,
      appCursorKeys: false,
      rawMode: false,
      cwd: opts.cwd,
      surfaceReady: false,
      exited: false,
      ptyId: null,
      searchRequest: 0,
    };
    startGlobalListeners();
    void this.start(opts.cwd);
  }

  // ── External store contract ──────────────────────────────────────────────

  readonly subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  readonly getSnapshot = (): SessionSnapshot => this.snapshot;

  private publish(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  private async start(cwd: string): Promise<void> {
    const channel = new Channel<ArrayBuffer | number[]>();
    channel.onmessage = (payload) => {
      if (this.closed) return;
      this.pendingChunks.push(payload);
      if (this.ptyId !== null) this.scheduleDrain();
    };
    // 80×24 until a view measures: a terminal created hidden (a command
    // terminal an agent asked for) must start its shell — and its queued
    // command — now, not when it is first looked at.
    const size = this.lastSize ?? { cols: 80, rows: 24 };
    let id: string;
    try {
      id = await invoke<string>("terminal_create", {
        cols: size.cols,
        rows: size.rows,
        cwd,
        onOutput: channel,
      });
    } catch (e) {
      console.warn("terminal_create failed:", e);
      this.publish({ exited: true });
      return;
    }
    if (this.closed) {
      void invoke("terminal_close", { id }).catch(() => {});
      return;
    }
    this.ptyId = id;
    reg.byPty.set(id, this);
    this.publish({ ptyId: id });
    if (this.pendingChunks.length > 0) this.scheduleDrain();
    window.addEventListener("atlas:window-active", this.scheduleDrain);

    // A command the opener queued for this terminal — an agent's login, today.
    // Written into the shell rather than exec'd, so it runs with a real tty and
    // a login that asks a question can be answered. Taken ONCE per session, so
    // neither a remount nor a workspace round trip re-runs it.
    this.queuedCommand = useTerminalStore.getState().actions.takePendingCommand(this.key) ?? null;
    if (this.queuedCommand !== null) {
      // A shell with no OSC 133 integration never reports a prompt, so the wait
      // needs a floor as well as a signal. Late is recoverable; never is not.
      this.queuedFloor = window.setTimeout(() => this.sendQueued(), 1500);
    }
    if (this.fitPending) this.requestFit();
  }

  private sendQueued(): void {
    if (this.queuedCommand === null || this.ptyId === null) return;
    const line = this.queuedCommand;
    this.queuedCommand = null;
    if (this.queuedFloor) window.clearTimeout(this.queuedFloor);
    this.queuedFloor = 0;
    void invoke("terminal_write_text", { id: this.ptyId, text: `${line}\n` }).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.drainRaf) cancelAnimationFrame(this.drainRaf);
    if (this.drainBackstop) window.clearTimeout(this.drainBackstop);
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    if (this.queuedFloor) window.clearTimeout(this.queuedFloor);
    if (this.xtermLinger) window.clearTimeout(this.xtermLinger);
    this.drainRaf = this.drainBackstop = this.resizeTimer = this.queuedFloor = this.xtermLinger = 0;
    window.removeEventListener("atlas:window-active", this.scheduleDrain);
    this.disposeXterm();
    this.surfaceEl.remove();
    reg.sessions.delete(this.key);
    useTerminalStore.getState().actions.setTerminalBusy(this.key, false);
    const id = this.ptyId;
    if (id) {
      reg.byPty.delete(id);
      await invoke("terminal_close", { id }).catch(() => {});
    }
  }

  /** @internal — registry listener. */
  onExited(): void {
    this.publish({ exited: true });
  }

  /** @internal — registry listener. */
  onRawMode(raw: boolean): void {
    if (raw !== this.snapshot.rawMode) this.publish({ rawMode: raw });
  }

  // ── Output path ──────────────────────────────────────────────────────────

  private readonly scheduleDrain = (): void => {
    if (this.drainRaf || this.closed) return;
    this.drainRaf = requestAnimationFrame(this.drain);
    this.drainBackstop = window.setTimeout(this.drain, DRAIN_BACKSTOP_MS);
  };

  private readonly drain = (): void => {
    if (this.drainRaf) cancelAnimationFrame(this.drainRaf);
    if (this.drainBackstop) window.clearTimeout(this.drainBackstop);
    this.drainRaf = 0;
    this.drainBackstop = 0;
    if (this.closed || this.ptyId === null) return;
    const start = performance.now();
    let consumed = 0;
    let bytes = 0;
    while (this.pendingChunks.length > 0) {
      if (
        consumed > 0 &&
        (performance.now() - start >= DRAIN_BUDGET_MS || bytes >= DRAIN_BYTE_CAP)
      ) {
        break;
      }
      const chunk = this.pendingChunks.shift()!;
      const u8 = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : new Uint8Array(chunk);
      bytes += u8.byteLength;
      const end = perfBegin("chunk");
      perfBytes(u8.byteLength);
      this.parser.push(this.decoder.decode(u8, { stream: true }));
      end();
      consumed++;
    }
    if (consumed > 0) {
      // Ack AFTER consumption, once: the credit window is then real
      // end-to-end backpressure (see terminal.rs).
      void invoke("terminal_ack", { id: this.ptyId, count: consumed }).catch(() => {});
      if (this.parser.hasDrawnPrompt) this.sendQueued();
      // One commit per frame — unless hidden (nothing to paint) or the reader
      // is mid-fling (the paint waits; the parse and the ack did not). Hidden,
      // the session still owes the tab strip its busy state and owes itself a
      // rebuild on show — neither waits on the parser's late backstop timer.
      if (this.visible && !isScrollHot()) this.parser.flushNow();
      else {
        this.dirtyWhileHidden = true;
        this.updateBusy();
      }
    }
    if (this.pendingChunks.length > 0) this.scheduleDrain();
  };

  private updateBusy(): void {
    const last = this.parser.blocks[this.parser.blocks.length - 1];
    const busy = !!last && last.running && last.command !== "";
    if (busy !== this.busy) {
      this.busy = busy;
      // Flows even while hidden: the tab strip's spinner is how a background
      // terminal says it is working.
      useTerminalStore.getState().actions.setTerminalBusy(this.key, busy);
    }
  }

  private onParserChange(): void {
    this.updateBusy();
    const last = this.parser.blocks[this.parser.blocks.length - 1];
    if (last && !last.running && last.command && last.id !== this.perfClosedFor) {
      this.perfClosedFor = last.id;
      perfBlockDone(last.command);
    }
    if (!this.visible) {
      this.dirtyWhileHidden = true;
      return;
    }
    this.publishFromParser();
  }

  private publishFromParser(): void {
    this.dirtyWhileHidden = false;
    this.flushEnd?.();
    this.flushEnd = perfBegin("flush");
    this.publish({
      blocks: [...this.parser.blocks],
      altScreen: this.parser.altScreen,
      appCursorKeys: this.parser.appCursorKeys,
      cwd: this.parser.currentCwd,
    });
  }

  /** The view committed the last snapshot (dev perf only). */
  committed(): void {
    this.flushEnd?.();
    this.flushEnd = null;
  }

  private onParserEvent(e: TerminalEvent): void {
    if (e.type === "altScreenEnter") {
      if (this.xtermLinger) {
        window.clearTimeout(this.xtermLinger);
        this.xtermLinger = 0;
      }
      if (this.visible && this.host) void this.ensureXterm();
    } else if (e.type === "altScreenLeave") {
      if (this.xtermLinger) window.clearTimeout(this.xtermLinger);
      this.xtermLinger = window.setTimeout(() => {
        this.xtermLinger = 0;
        if (!this.parser.altScreen) this.disposeXterm();
      }, XTERM_LINGER_MS);
    }
  }

  // ── xterm (lazy) ─────────────────────────────────────────────────────────

  private feedXterm(text: string): void {
    if (this.xterm && this.visible) {
      this.xterm.write(text);
      return;
    }
    // Held for a surface that does not exist yet or is not on screen. Past
    // the cap the ring is abandoned: on show, a SIGWINCH nudge makes the app
    // repaint instead (every alt-screen app handles resize).
    if (this.xtermRingOverflow) return;
    this.xtermRing.push(text);
    this.xtermRingBytes += text.length;
    if (this.xtermRingBytes > XTERM_RING_CAP) {
      this.xtermRing = [];
      this.xtermRingBytes = 0;
      this.xtermRingOverflow = true;
    }
  }

  private replayRing(): void {
    if (!this.xterm) return;
    if (this.xtermRingOverflow) {
      this.xtermRingOverflow = false;
      this.nudgeRedraw();
      return;
    }
    for (const t of this.xtermRing) this.xterm.write(t);
    this.xtermRing = [];
    this.xtermRingBytes = 0;
  }

  /** SIGWINCH twice: any full-screen app repaints on resize. */
  private nudgeRedraw(): void {
    const id = this.ptyId;
    const size = this.lastSize;
    if (!id || !size) return;
    void invoke("terminal_resize", { id, cols: size.cols, rows: Math.max(1, size.rows - 1) })
      .then(() => invoke("terminal_resize", { id, cols: size.cols, rows: size.rows }))
      .catch(() => {});
  }

  private async ensureXterm(): Promise<void> {
    if (this.xterm || this.xtermCreating || this.closed) return;
    this.xtermCreating = true;
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
      ]);
      const fontFamily = await resolveTerminalFont(FONT_SIZE);
      if (this.closed || !this.host) return;
      const term = new Terminal({
        fontFamily,
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        // The alt screen has no scrollback — the block list owns history.
        scrollback: 0,
        cursorBlink: true,
        allowProposedApi: true,
        theme: XTERM_THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      try {
        const { Unicode11Addon } = await import("@xterm/addon-unicode11");
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = "11";
      } catch {
        /* non-fatal */
      }
      term.open(this.surfaceEl);
      if (reg.webglCount < MAX_WEBGL) {
        try {
          const { WebglAddon } = await import("@xterm/addon-webgl");
          const w = new WebglAddon();
          reg.webglCount++;
          w.onContextLoss(() => {
            w.dispose();
            if (this.webgl === w) this.webgl = null;
            reg.webglCount = Math.max(0, reg.webglCount - 1);
          });
          term.loadAddon(w);
          this.webgl = w;
        } catch {
          /* DOM renderer */
        }
      }
      this.xterm = term;
      this.fit = fit;

      // Interactive-surface parity with a classic terminal: word/line
      // navigation + ⌘C/⌘V/⌘A copy-paste, and ⌘-click file paths.
      const keymap = createTerminalKeymap(term);
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const nav = keymap(e);
        if (nav === "handled") return false;
        if (typeof nav === "string") {
          this.writeText(nav);
          return false;
        }
        const mod = e.metaKey || (e.ctrlKey && e.shiftKey);
        const key = e.key.toLowerCase();
        if (mod && key === "c") {
          if (term.hasSelection()) {
            e.preventDefault();
            void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          }
          return false;
        }
        if (mod && key === "v") {
          e.preventDefault();
          void navigator.clipboard
            .readText()
            .then((t) => t && term.paste(t))
            .catch(() => {});
          return false;
        }
        if (e.metaKey && key === "a") {
          e.preventDefault();
          term.selectAll();
          return false;
        }
        return true;
      });
      if (this.ptyId) term.registerLinkProvider(createPathLinkProvider(term, this.ptyId));
      term.onData((d) => this.writeText(d));

      this.replayRing();
      this.publish({ surfaceReady: true });
      this.requestFit();
    } finally {
      this.xtermCreating = false;
    }
  }

  private disposeXterm(): void {
    if (!this.xterm) return;
    try {
      this.webgl?.dispose();
    } catch {
      /* already lost */
    }
    if (this.webgl) reg.webglCount = Math.max(0, reg.webglCount - 1);
    this.webgl = null;
    this.xterm.dispose();
    this.xterm = null;
    this.fit = null;
    this.xtermRing = [];
    this.xtermRingBytes = 0;
    this.xtermRingOverflow = false;
    if (!this.closed) this.publish({ surfaceReady: false });
  }

  focusXterm(): void {
    this.xterm?.focus();
  }

  // ── View attachment + visibility ─────────────────────────────────────────

  /** Put the surface in the given host. Returns the detach function. */
  attach(host: HTMLElement): () => void {
    this.host = host;
    host.appendChild(this.surfaceEl);
    if (this.parser.altScreen && this.visible) void this.ensureXterm();
    if (this.fitPending) this.requestFit();
    return () => {
      if (this.host === host) this.host = null;
      this.surfaceEl.remove();
    };
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    if (!visible) return;
    // Through the parser, not straight to publish: `flushNow` syncs the live
    // block's resolved lines first, then calls back into `onParserChange`.
    if (this.dirtyWhileHidden) this.parser.flushNow();
    if (this.parser.altScreen && this.host) void this.ensureXterm();
    else this.replayRing();
    if (this.fitPending) this.requestFit();
  }

  // ── Size ─────────────────────────────────────────────────────────────────

  /**
   * Fit the PTY to the surface. Coalesced, deduplicated, and never a 2×1: a
   * hidden or zero-size host defers until a real box exists.
   */
  requestFit(): void {
    const host = this.host;
    if (!host || this.closed) {
      this.fitPending = true;
      return;
    }
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (w === 0 || h === 0) {
      this.fitPending = true;
      return;
    }
    if (this.xterm && this.fit) {
      try {
        this.fit.fit();
      } catch {
        return;
      }
      this.applySize(this.xterm.cols, this.xterm.rows);
      return;
    }
    void cellSize().then((cell) => {
      if (this.closed) return;
      // Match xterm's own padding (the surface has 4px on each side).
      this.applySize(Math.floor((w - 8) / cell.w), Math.floor((h - 8) / cell.h));
    });
  }

  private applySize(cols: number, rows: number): void {
    if (cols < MIN_COLS || rows < MIN_ROWS) {
      this.fitPending = true;
      return;
    }
    this.fitPending = false;
    this.parser.setRows(rows);
    if (this.lastSize && this.lastSize.cols === cols && this.lastSize.rows === rows) return;
    this.lastSize = { cols, rows };
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    // First call fires now; the rest of a drag coalesces onto a trailing timer.
    const send = () => {
      this.resizeTimer = 0;
      const id = this.ptyId;
      const size = this.lastSize;
      if (!id || !size) return;
      void invoke("terminal_resize", { id, cols: size.cols, rows: size.rows }).catch(() => {});
    };
    if (!this.resizeTimer) send();
    this.resizeTimer = window.setTimeout(send, RESIZE_COALESCE_MS);
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private writeText(text: string): void {
    const id = this.ptyId;
    if (id) void invoke("terminal_write_text", { id, text }).catch(() => {});
  }

  /** Forward raw bytes — the composer feeds nav keys to a running prompt. */
  writeRaw(data: number[]): void {
    const id = this.ptyId;
    if (id) void invoke("terminal_write", { id, data }).catch(() => {});
  }

  /** A secret typed into a block's inline password field. Never stored. */
  writePassword(pw: string): void {
    this.writeText(pw + "\n");
  }

  runCommand(cmd: string): void {
    const id = this.ptyId;
    if (!id) return;
    const trimmed = cmd.trim();
    // `clear` clears OUR block list; a bare newline makes the shell redraw a
    // fresh prompt.
    if (trimmed === "clear") {
      this.parser.clearBlocks();
      void invoke("terminal_write", { id, data: [0x0a] }).catch(() => {});
      return;
    }
    // Relaunch an interactive root shell with Atlas's zsh integration so blocks
    // / prompt markers keep working as root. $HOME is expanded by the root zsh.
    if (SUDO_SHELL_RE.test(trimmed) && reg.zshDir) {
      this.writeText(
        `sudo zsh -c 'ZDOTDIR="${reg.zshDir}" ATLAS_USER_ZDOTDIR="$HOME" exec zsh -i'\n`,
      );
      return;
    }
    this.writeText(cmd + "\n");
  }

  interrupt(): void {
    this.writeRaw([0x03]);
  }

  async killForeground(): Promise<boolean> {
    const id = this.ptyId;
    if (!id) return false;
    return invoke<boolean>("terminal_kill_foreground", { id });
  }

  /** After a SIGKILL the app never sent its alt-screen leave; apply it locally
   *  so the prompt is visible again. The parser forwards it to xterm too. */
  restoreBlockSurface(): void {
    if (!this.parser.altScreen) return;
    this.parser.push("\x1b[?1049l");
  }

  requestSearch(): void {
    this.publish({ searchRequest: this.snapshot.searchRequest + 1 });
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

export const terminalSessions = {
  /** Idempotent: the same key returns the same live session. */
  acquire(key: string, opts: AcquireOptions): TerminalSession {
    let s = reg.sessions.get(key);
    if (!s) {
      s = new TerminalSession(key, opts);
      reg.sessions.set(key, s);
    }
    return s;
  },
  get(key: string): TerminalSession | undefined {
    return reg.sessions.get(key);
  },
  close(key: string): Promise<void> {
    return reg.sessions.get(key)?.close() ?? Promise.resolve();
  },
  closeMany(keys: Iterable<string>): void {
    for (const k of keys) void this.close(k);
  },
  /** Every session. Tests, and a hard reset. */
  closeAll(): Promise<void> {
    return Promise.all([...reg.sessions.keys()].map((k) => this.close(k))).then(() => {});
  },
  /**
   * Close every session whose terminal has left the store. One subscription
   * covers every close path — terminal, pane, tab, workspace discard.
   */
  bindToStore(): () => void {
    if (reg.storeBound) return () => {};
    reg.storeBound = true;
    const sweep = () => {
      const live = new Set<string>();
      for (const t of Object.values(useTerminalStore.getState().tabs)) {
        for (const pane of collectPanes(t.root)) for (const id of pane.terminals) live.add(id);
      }
      for (const key of reg.sessions.keys()) if (!live.has(key)) void this.close(key);
    };
    const unsub = useTerminalStore.subscribe(sweep);
    return () => {
      reg.storeBound = false;
      unsub();
    };
  },
};
