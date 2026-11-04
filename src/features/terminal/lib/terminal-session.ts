/**
 * A terminal session that outlives React.
 *
 * One PTY and one xterm per layout terminal id, held in a module-level
 * registry. PTY output goes straight into xterm; xterm's keystrokes go
 * straight to the PTY — a plain terminal, as in any editor's integrated
 * terminal. React components ATTACH a view to a session and detach again;
 * nothing about a remount, a column move, a pane split or a project switch
 * touches the shell or the scrollback.
 *
 * What this buys, concretely:
 *  - a build running in project A keeps running while you look at B (the
 *    panel unmounts; the session and its xterm buffer do not);
 *  - closing a split column or moving a tab no longer respawns its shells;
 *  - StrictMode's mount → unmount → mount no longer creates two PTYs;
 *  - a hidden session keeps parsing (its buffer stays correct, `busy` keeps
 *    flowing to the tab strip) but holds no WebGL context.
 *
 * WebGL contexts come out of a page-wide budget (`MAX_WEBGL`), because
 * WKWebView caps contexts and silently degrades the ones past the cap. Only a
 * VISIBLE terminal holds one; hidden ones fall back to xterm's DOM renderer.
 *
 * Shell integration (OSC 133 / 6973 / 7 from our zsh rc) is read through
 * xterm's OSC hooks into `ShellIntegration`, which feeds the notifier and the
 * tab strip's busy state.
 *
 * Lifetime: `terminalSessions.bindToStore()` closes a session the moment its
 * terminal id disappears from `useTerminalStore` — the one seam that covers
 * every close path (terminal, pane, tab, project discard).
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { WebglAddon } from "@xterm/addon-webgl";
import { onThemeApplied } from "@/features/theme/theme-values";
import { terminalTheme } from "./terminal-theme";
import { ShellIntegration } from "./shell-integration";
import { createTerminalEventSink } from "./terminal-notifier";
import { createTerminalKeymap } from "./terminal-keymap";
import { createPathLinkProvider } from "./path-link-provider";
import { resolveTerminalFont } from "../utils/resolve-font";
import {
  appliedTerminalFont,
  appliedTerminalFontSize,
  DISPLAY_SETTINGS_APPLIED,
} from "@/features/settings/lib/display-settings";
import { collectPanes, useTerminalStore } from "../stores/terminal-store";

// ── Public shapes ──────────────────────────────────────────────────────────

export interface SessionSnapshot {
  cwd: string;
  /** The foreground command while one runs (shell integration), else null. */
  command: string | null;
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

/** Where a find landed: 1-based `index` of `total` matches (0 of 0: none). */
export interface FindResult {
  index: number;
  total: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Lines of history each terminal keeps. */
const SCROLLBACK = 10_000;
/** WKWebView caps WebGL contexts around 16 per page; leave headroom. */
const MAX_WEBGL = 8;
/** Trailing coalesce for `terminal_resize` during a drag. */
const RESIZE_COALESCE_MS = 40;
/** Below this the box is not a terminal yet (a hidden 0×0 fits to 2×1). */
const MIN_COLS = 10;
const MIN_ROWS = 3;
/** A queued command waits for the shell's first prompt marker, or this long
 *  for a shell with no integration. Late is recoverable; never is not. */
const QUEUED_FLOOR_MS = 1500;

/** `terminalFontSize`, as `display-settings.ts` last applied it. */
const fontSize = () => appliedTerminalFontSize();
const LINE_HEIGHT = 1.4;

// ── Module state (survives HMR via globalThis) ─────────────────────────────

interface Registry {
  sessions: Map<string, TerminalSession>;
  byPty: Map<string, TerminalSession>;
  webglCount: number;
  /** Addons currently counted in `webglCount`. A Set rather than a bare
   * counter so a repeat release for the same addon — the session's own
   * teardown and its `onContextLoss` callback can both fire for one
   * instance — cannot skew the count. Same shape as `registerPixiApp` /
   * `destroyPixiApp` in `src/lib/pixi-app.ts`. */
  webglLive: Set<WebglAddon>;
  listenersStarted: boolean;
  storeBound: boolean;
}
const g = globalThis as unknown as { __atlasTerminalSessions?: Registry };
const reg: Registry = (g.__atlasTerminalSessions ??= {
  sessions: new Map(),
  byPty: new Map(),
  webglCount: 0,
  webglLive: new Set(),
  listenersStarted: false,
  storeBound: false,
});

/**
 * Release one WebGL context back to the page-wide budget. Safe to call twice
 * for the same addon — the session's own release and a late `onContextLoss`
 * for that same instance are both real possibilities, and the second call is
 * a no-op rather than an extra decrement.
 */
function releaseWebgl(w: WebglAddon): void {
  if (!reg.webglLive.delete(w)) return;
  reg.webglCount = Math.max(0, reg.webglCount - 1);
}

function startGlobalListeners(): void {
  if (reg.listenersStarted) return;
  reg.listenersStarted = true;
  void listen<{ id: string }>("terminal-exit", (evt) => {
    reg.byPty.get(evt.payload.id)?.onExited();
  });
  // One subscription for every session: xterm takes a palette as concrete
  // strings (`options.theme`), so a theme switch has to be pushed in.
  onThemeApplied(() => {
    for (const session of reg.sessions.values()) session.retheme();
  });
  // The same for `terminalFontSize` and the terminal font.
  let applied = `${fontSize()}|${appliedTerminalFont()}`;
  window.addEventListener(DISPLAY_SETTINGS_APPLIED, () => {
    const next = `${fontSize()}|${appliedTerminalFont()}`;
    if (next === applied) return;
    applied = next;
    for (const session of reg.sessions.values()) void session.refont();
  });
}

// ── Session ────────────────────────────────────────────────────────────────

export class TerminalSession {
  readonly key: string;
  readonly tabId: string;
  /** When the shell was started. */
  readonly createdAt = Date.now();
  /** The element xterm opens into. Views append it; it is never recreated. */
  readonly surfaceEl: HTMLDivElement;

  private readonly shell: ShellIntegration;
  private readonly listeners = new Set<() => void>();
  private snapshot: SessionSnapshot;

  private ptyId: string | null = null;
  private closed = false;
  /** Output that arrived before xterm existed. */
  private readonly pendingChunks: Uint8Array[] = [];
  private unacked = 0;
  private ackTimer = 0;
  private queuedCommand: string | null = null;
  /** False for a line queued to be typed, not run (see `pendingTyped`). */
  private queuedExecute = true;
  private queuedFloor = 0;

  private host: HTMLElement | null = null;
  private visible = false;
  private busy = false;

  private xterm: Terminal | null = null;
  private fit: FitAddon | null = null;
  private webgl: WebglAddon | null = null;
  private opened = false;
  private linksRegistered = false;

  private lastSize: { cols: number; rows: number } | null = null;
  private resizeTimer = 0;
  private fitPending = false;
  private findIdx = -1;

  constructor(key: string, opts: AcquireOptions) {
    this.key = key;
    this.tabId = opts.tabId;
    this.surfaceEl = document.createElement("div");
    this.surfaceEl.className = "absolute inset-0";

    const notify = createTerminalEventSink({ terminalId: key, tabId: opts.tabId });
    this.shell = new ShellIntegration(opts.cwd, notify, () => this.onShellChange());
    this.snapshot = {
      cwd: opts.cwd,
      command: null,
      exited: false,
      ptyId: null,
      searchRequest: 0,
    };
    startGlobalListeners();
    void this.createXterm();
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
      const u8 =
        payload instanceof ArrayBuffer ? new Uint8Array(payload) : Uint8Array.from(payload);
      if (this.xterm) this.writeOutput(u8);
      else this.pendingChunks.push(u8);
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
      this.onExited();
      return;
    }
    if (this.closed) {
      void invoke("terminal_close", { id }).catch(() => {});
      return;
    }
    this.ptyId = id;
    reg.byPty.set(id, this);
    this.publish({ ptyId: id });
    this.registerLinks();
    // A size measured while the PTY was being created.
    if (this.lastSize && (this.lastSize.cols !== size.cols || this.lastSize.rows !== size.rows)) {
      void invoke("terminal_resize", { id, ...this.lastSize }).catch(() => {});
    }

    // A command the opener queued for this terminal — an agent's login, today.
    // Written into the shell rather than exec'd, so it runs with a real tty and
    // a login that asks a question can be answered. Taken ONCE per session, so
    // neither a remount nor a project round trip re-runs it.
    // Read before the take, which clears it.
    this.queuedExecute = !useTerminalStore.getState().pendingTyped[this.key];
    this.queuedCommand = useTerminalStore.getState().actions.takePendingCommand(this.key) ?? null;
    if (this.queuedCommand !== null) {
      if (this.shell.hasDrawnPrompt) this.sendQueued();
      else this.queuedFloor = window.setTimeout(() => this.sendQueued(), QUEUED_FLOOR_MS);
    }
  }

  private sendQueued(): void {
    if (this.queuedCommand === null || this.ptyId === null) return;
    const line = this.queuedCommand;
    this.queuedCommand = null;
    if (this.queuedFloor) window.clearTimeout(this.queuedFloor);
    this.queuedFloor = 0;
    // CR is what the Enter key sends; the tty turns it into end-of-line.
    this.writeText(this.queuedExecute ? line + "\r" : line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.resizeTimer) window.clearTimeout(this.resizeTimer);
    if (this.queuedFloor) window.clearTimeout(this.queuedFloor);
    if (this.ackTimer) window.clearTimeout(this.ackTimer);
    this.resizeTimer = this.queuedFloor = this.ackTimer = 0;
    this.releaseRenderer();
    this.xterm?.dispose();
    this.xterm = null;
    this.fit = null;
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
    if (this.snapshot.exited) return;
    if (this.xterm) this.writeExitNote(this.xterm);
    this.publish({ exited: true });
  }

  private writeExitNote(term: Terminal): void {
    term.write("\r\n\x1b[2m[Shell exited — close this terminal or open a new one]\x1b[0m\r\n");
  }

  // ── xterm ────────────────────────────────────────────────────────────────

  private async createXterm(): Promise<void> {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ]);
    const size = fontSize();
    const fontFamily = await resolveTerminalFont(size, appliedTerminalFont());
    if (this.closed) return;
    const term = new Terminal({
      fontFamily,
      fontSize: size,
      lineHeight: LINE_HEIGHT,
      scrollback: SCROLLBACK,
      cursorBlink: true,
      allowProposedApi: true,
      theme: terminalTheme(),
      cols: this.lastSize?.cols ?? 80,
      rows: this.lastSize?.rows ?? 24,
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
    if (this.closed) {
      term.dispose();
      return;
    }

    // Shell integration, read off the OSC stream.
    const sh = this.shell;
    term.parser.registerOscHandler(133, (d) => sh.osc133(d));
    term.parser.registerOscHandler(6973, (d) => sh.osc6973(d));
    term.parser.registerOscHandler(7, (d) => sh.osc7(d));
    term.parser.registerOscHandler(9, (d) => sh.osc9(d));
    term.parser.registerOscHandler(777, (d) => sh.osc777(d));
    term.onBell(() => sh.bell());
    term.buffer.onBufferChange((b) => sh.setAltScreen(b.type === "alternate"));

    // Word/line navigation, ⌘C/⌘V/⌘A copy-paste; everything else is xterm's.
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
    term.onData((d) => this.writeText(d));
    // Mouse reports in the legacy X10 encoding are bytes, not text.
    term.onBinary((d) => {
      const id = this.ptyId;
      if (!id) return;
      const data = Array.from(d, (c) => c.charCodeAt(0) & 0xff);
      void invoke("terminal_write", { id, data }).catch(() => {});
    });

    this.xterm = term;
    this.fit = fit;
    this.registerLinks();
    for (const chunk of this.pendingChunks.splice(0)) this.writeOutput(chunk);
    if (this.snapshot.exited) this.writeExitNote(term);
    this.openIfReady();
  }

  /** ⌘-click URLs and file paths. Needs the PTY id (paths resolve against the
   *  shell's live cwd), so it waits for both halves. */
  private registerLinks(): void {
    if (this.linksRegistered || !this.xterm || !this.ptyId) return;
    this.linksRegistered = true;
    this.xterm.registerLinkProvider(createPathLinkProvider(this.xterm, this.ptyId));
  }

  /** Open xterm into its surface once both exist and the surface is in the
   *  document (xterm measures its cell size on open). */
  private openIfReady(): void {
    const term = this.xterm;
    if (!term || this.opened || !this.host || !this.surfaceEl.isConnected) return;
    term.open(this.surfaceEl);
    this.opened = true;
    this.syncRenderer();
    this.requestFit();
  }

  /** Visible terminals hold a WebGL context while the budget allows; hidden
   *  ones give theirs back and render through the DOM. */
  private syncRenderer(): void {
    if (!this.visible || !this.opened) {
      this.releaseRenderer();
      return;
    }
    if (this.webgl || reg.webglCount >= MAX_WEBGL) return;
    void import("@xterm/addon-webgl")
      .then(({ WebglAddon }) => {
        const term = this.xterm;
        if (!term || this.closed || !this.visible || this.webgl) return;
        if (reg.webglCount >= MAX_WEBGL) return;
        const w = new WebglAddon();
        reg.webglLive.add(w);
        reg.webglCount++;
        w.onContextLoss(() => {
          if (this.webgl === w) this.webgl = null;
          try {
            w.dispose();
          } catch {
            /* already lost */
          }
          releaseWebgl(w);
        });
        try {
          term.loadAddon(w);
          this.webgl = w;
        } catch {
          releaseWebgl(w);
        }
      })
      .catch(() => {
        /* DOM renderer */
      });
  }

  private releaseRenderer(): void {
    // Clear the field before disposing: `dispose()` can fire the addon's own
    // `onContextLoss`, which reads `this.webgl` too. `releaseWebgl` keeps the
    // count-down idempotent either way.
    const w = this.webgl;
    this.webgl = null;
    if (!w) return;
    try {
      w.dispose();
    } catch {
      /* already lost */
    }
    releaseWebgl(w);
  }

  /**
   * Push the active theme's palette into the terminal. Called for every
   * session on `atlas:theme-applied`.
   */
  retheme(): void {
    if (this.xterm) this.xterm.options.theme = terminalTheme();
  }

  /** Take the current `terminalFontSize` and font, then refit. */
  async refont(): Promise<void> {
    if (!this.xterm) return;
    const size = fontSize();
    const fontFamily = await resolveTerminalFont(size, appliedTerminalFont());
    if (!this.xterm || this.closed) return;
    this.xterm.options.fontSize = size;
    this.xterm.options.fontFamily = fontFamily;
    this.requestFit();
  }

  focus(): void {
    this.xterm?.focus();
  }

  // ── Output path ──────────────────────────────────────────────────────────

  private writeOutput(u8: Uint8Array): void {
    const term = this.xterm!;
    term.write(u8, () => {
      // Ack once xterm has PARSED the chunk: the credit window is then real
      // end-to-end backpressure (see terminal.rs). Batched to one IPC per task.
      this.unacked++;
      if (!this.ackTimer) this.ackTimer = window.setTimeout(this.flushAcks, 0);
      if (this.shell.hasDrawnPrompt && this.queuedCommand !== null) this.sendQueued();
      const buf = term.buffer.active;
      const line = buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? "";
      this.shell.checkPasswordPrompt(line);
    });
  }

  private readonly flushAcks = (): void => {
    this.ackTimer = 0;
    const n = this.unacked;
    this.unacked = 0;
    const id = this.ptyId;
    if (n > 0 && id && !this.closed) {
      void invoke("terminal_ack", { id, count: n }).catch(() => {});
    }
  };

  private onShellChange(): void {
    const command = this.shell.command;
    const busy = command !== null;
    if (busy !== this.busy) {
      this.busy = busy;
      // Flows even while hidden: the tab strip's spinner is how a background
      // terminal says it is working.
      useTerminalStore.getState().actions.setTerminalBusy(this.key, busy);
    }
    if (command !== this.snapshot.command || this.shell.cwd !== this.snapshot.cwd) {
      this.publish({ command, cwd: this.shell.cwd });
    }
  }

  // ── View attachment + visibility ─────────────────────────────────────────

  /** Put the surface in the given host. Returns the detach function. */
  attach(host: HTMLElement): () => void {
    this.host = host;
    host.appendChild(this.surfaceEl);
    this.openIfReady();
    if (this.fitPending) this.requestFit();
    return () => {
      if (this.host === host) this.host = null;
      this.surfaceEl.remove();
    };
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.syncRenderer();
    if (visible && this.fitPending) this.requestFit();
  }

  // ── Size ─────────────────────────────────────────────────────────────────

  /**
   * Fit the terminal and the PTY to the surface. Coalesced, deduplicated, and
   * never a 2×1: a hidden or zero-size host defers until a real box exists.
   */
  requestFit(): void {
    const host = this.host;
    if (!host || this.closed || !this.fit || !this.opened) {
      this.fitPending = true;
      return;
    }
    if (host.clientWidth === 0 || host.clientHeight === 0) {
      this.fitPending = true;
      return;
    }
    let dims: { cols: number; rows: number } | undefined;
    try {
      dims = this.fit.proposeDimensions();
    } catch {
      dims = undefined;
    }
    if (!dims || dims.cols < MIN_COLS || dims.rows < MIN_ROWS) {
      this.fitPending = true;
      return;
    }
    this.fitPending = false;
    if (this.xterm && (this.xterm.cols !== dims.cols || this.xterm.rows !== dims.rows)) {
      this.xterm.resize(dims.cols, dims.rows);
    }
    this.applySize(dims.cols, dims.rows);
  }

  private applySize(cols: number, rows: number): void {
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

  // ── Find ─────────────────────────────────────────────────────────────────

  requestSearch(): void {
    this.publish({ searchRequest: this.snapshot.searchRequest + 1 });
  }

  /**
   * Select the next (`1`) or previous (`-1`) case-insensitive match of
   * `query` in the scrollback and scroll it into view. `restart` begins again
   * from the newest output (the query changed). Matches are found per buffer
   * row: one that wraps across rows is not found.
   */
  find(query: string, dir: 1 | -1, restart = false): FindResult {
    const term = this.xterm;
    if (!term || !query) {
      this.findIdx = -1;
      term?.clearSelection();
      return { index: 0, total: 0 };
    }
    const q = query.toLowerCase();
    const buf = term.buffer.active;
    const matches: { row: number; col: number }[] = [];
    for (let row = 0; row < buf.length; row++) {
      const text = buf.getLine(row)?.translateToString(true).toLowerCase();
      if (!text) continue;
      for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + q.length)) {
        matches.push({ row, col: i });
      }
    }
    if (matches.length === 0) {
      this.findIdx = -1;
      term.clearSelection();
      return { index: 0, total: 0 };
    }
    if (restart || this.findIdx < 0) this.findIdx = matches.length - 1;
    else this.findIdx = (this.findIdx + dir + matches.length) % matches.length;
    const m = matches[this.findIdx];
    term.select(m.col, m.row, q.length);
    term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 2)));
    return { index: this.findIdx + 1, total: matches.length };
  }

  clearFind(): void {
    this.findIdx = -1;
    this.xterm?.clearSelection();
  }
}

// ── Registry ───────────────────────────────────────────────────────────────

/** Live WebGL-context count against the page-wide `MAX_WEBGL` budget.
 * Exported for tests. */
export function liveWebglCount(): number {
  return reg.webglCount;
}

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
   * covers every close path — terminal, pane, tab, project discard.
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
