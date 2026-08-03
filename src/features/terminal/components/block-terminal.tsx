import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader2, CheckCircle2, XCircle, ChevronRight, Folder, Copy, RotateCw, ChevronDown, ChevronUp, Search, X, GitBranch, Lock } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { openFileOrReveal } from "@/lib/open-file";
import { useProjectStore } from "@/features/project/stores/project-store";
import { resolveTerminalFont } from "../utils/resolve-font";
import { resolveTerminalOutput, type AnsiSegment } from "../lib/ansi-to-segments";
import { splitLinks, normalizeUrl } from "../lib/linkify-paths";
import { createTerminalKeymap } from "../lib/terminal-keymap";
import { createPathLinkProvider } from "../lib/path-link-provider";
import { BlockStreamParser, type TerminalBlock } from "../lib/block-parser";
import { CommandInput, type CommandInputHandle } from "./command-input";
import { useTerminalStore } from "../stores/terminal-store";
import { safeUnlisten } from "@/lib/safe-unlisten";

/** Compact git status for the input-area badge. */
interface TermGit {
  branch: string;
  ahead: number;
  behind: number;
  dirty: boolean;
}

interface RawGitStatus {
  is_repo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: unknown[];
}

// Interactive root-shell invocations (no trailing command). These start a root
// shell that WON'T load Atlas's zsh integration (sudo strips the env), so we
// relaunch them through our integration ZDOTDIR — otherwise command blocks /
// prompt markers break as root ("sudo -s behaves weirdly").
const SUDO_SHELL_RE = /^sudo\s+(?:-s|-i|su(?:\s+-l?|\s+-)?)\s*$/;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** Wrap case-insensitive matches of `query` in `text` with a <mark>. Matches
 *  carry `data-term-match` so the search bar can scroll between them. */
function renderHL(text: string, query: string): ReactNode {
  if (!query) return text;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) {
      nodes.push(text.slice(i));
      break;
    }
    if (idx > i) nodes.push(text.slice(i, idx));
    nodes.push(
      <mark key={k++} data-term-match className="rounded-[2px] bg-[var(--status-warning)]/40 text-inherit">
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    i = idx + q.length;
  }
  return nodes;
}

interface BlockTerminalProps {
  isActive: boolean;
  onFocus: () => void;
  /** The terminal tab id (layout/terminal store), used to bind pending focus
   *  requests to the correct terminal tab. */
  tabId: string;
  /** The layout terminal id (terminal-store), used to report busy state to the
   *  tab strip. Distinct from the internal PTY session id. */
  terminalKey: string;
}

// ANSI palette for the interactive xterm surface — matches ansi-to-segments so
// blocks and the live surface look the same.
const XTERM_THEME = {
  background: "#000000",
  foreground: "#cccccc",
  cursor: "#b3b3b3",
  // Translucent so it's clearly visible on the AMOLED-black surface without
  // hiding the selected glyphs (opaque #303030 read as nearly invisible).
  selectionBackground: "rgba(97,175,239,0.35)",
  selectionInactiveBackground: "rgba(255,255,255,0.16)",
  black: "#1a1a1a", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
  blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#cccccc",
  brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
  brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
  brightCyan: "#56b6c2", brightWhite: "#ffffff",
};

/**
 * Block terminal. The PTY (zsh shell integration) streams raw bytes to BOTH:
 *   - an embedded xterm (the interactive surface) — shown only when an app
 *     enters the alt-screen (vim/htop/less); and
 *   - `BlockStreamParser`, which segments normal command output into React
 *     "blocks" rendered with ANSI→styled spans.
 * The React command input sends lines to the shell; when an alt-screen app is
 * running, keystrokes go to xterm instead.
 */
export function BlockTerminal({ isActive, onFocus, tabId, terminalKey }: BlockTerminalProps) {
  const [blocks, setBlocks] = useState<TerminalBlock[]>([]);
  const [altScreen, setAltScreen] = useState(false);
  const [cwd, setCwd] = useState<string>("");
  const [surfaceReady, setSurfaceReady] = useState(false);
  const [git, setGit] = useState<TermGit | null>(null);
  const [search, setSearch] = useState({ open: false, query: "" });
  const [matchCount, setMatchCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const matchIdxRef = useRef(-1);

  const parserRef = useRef<BlockStreamParser | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const ptyRef = useRef<string | null>(null);
  const focusPendingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<CommandInputHandle>(null);
  // zsh integration ZDOTDIR (for relaunching root shells with integration).
  const zshDirRef = useRef<string | null>(null);

  useEffect(() => {
    void invoke<string | null>("terminal_zsh_dir")
      .then((d) => { zshDirRef.current = d; })
      .catch(() => {});
  }, []);

  const xtermRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const xtermHostRef = useRef<HTMLDivElement>(null);

  const pendingFocus = useTerminalStore((s) => s.pendingFocus);
  const { clearPendingTerminalFocus } = useTerminalStore.use.actions();

  useEffect(() => {
    let disposed = false;
    let unOut: (() => void) | null = null;
    let unExit: (() => void) | null = null;
    const initialCwd = useProjectStore.getState().currentProject?.path ?? "~";

    const parser = new BlockStreamParser(initialCwd, () => {
      if (disposed) return;
      setBlocks([...parser.blocks]);
      setAltScreen(parser.altScreen);
      setCwd(parser.currentCwd);
    });
    setCwd(initialCwd);
    parserRef.current = parser;

    void (async () => {
      // Interactive surface (xterm) — processes the full stream so it's ready
      // the instant an app enters the alt-screen.
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      await import("@xterm/xterm/css/xterm.css");
      if (disposed || !xtermHostRef.current) return;
      const fontFamily = await resolveTerminalFont(13);
      if (disposed || !xtermHostRef.current) return;

      const term = new Terminal({
        fontFamily,
        fontSize: 13,
        lineHeight: 1.4,
        scrollback: 5000,
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
      term.open(xtermHostRef.current);
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const w = new WebglAddon();
        w.onContextLoss(() => w.dispose());
        term.loadAddon(w);
      } catch {
        /* DOM renderer */
      }
      xtermRef.current = term;
      fitRef.current = fit;
      setSurfaceReady(true);

      let cols = 80;
      let rows = 24;
      try {
        fit.fit();
        cols = term.cols;
        rows = term.rows;
      } catch {
        /* keep defaults */
      }

      const id = await invoke<string>("terminal_create", { cols, rows, cwd: initialCwd });
      if (disposed) {
        void invoke("terminal_close", { id }).catch(() => {});
        return;
      }
      ptyRef.current = id;

      // Interactive-surface parity with the classic terminal: word/line
      // navigation + ⌘C/⌘V/⌘A copy-paste, and ⌘-click file paths.
      const keymap = createTerminalKeymap(term);
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const nav = keymap(e);
        if (nav === "handled") return false;
        if (typeof nav === "string") {
          void invoke("terminal_write", {
            id,
            data: Array.from(new TextEncoder().encode(nav)),
          }).catch(() => {});
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
          void navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
          return false;
        }
        if (e.metaKey && key === "a") {
          e.preventDefault();
          term.selectAll();
          return false;
        }
        return true;
      });
      term.registerLinkProvider(createPathLinkProvider(term, id));

      // Keystrokes from the interactive surface → PTY.
      term.onData((d) => {
        const tid = ptyRef.current;
        if (tid && !disposed) {
          void invoke("terminal_write", {
            id: tid,
            data: Array.from(new TextEncoder().encode(d)),
          }).catch(() => {});
        }
      });

      unOut = await listen<{ id: string; data: number[] }>("terminal-output", (e) => {
        if (e.payload.id !== id || disposed) return;
        const bytes = new Uint8Array(e.payload.data);
        term.write(bytes); // interactive surface
        parser.push(decoderRef.current.decode(bytes, { stream: true })); // blocks
      });
      unExit = await listen<{ id: string }>("terminal-exit", () => {});
    })();

    return () => {
      disposed = true;
      safeUnlisten(unOut);
      safeUnlisten(unExit);
      xtermRef.current?.dispose();
      if (ptyRef.current) void invoke("terminal_close", { id: ptyRef.current }).catch(() => {});
    };
  }, []);

  // Keep the PTY sized to the surface (drives wrapping for both views).
  useEffect(() => {
    const host = xtermHostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const t = xtermRef.current;
      const f = fitRef.current;
      const id = ptyRef.current;
      if (!t || !f) return;
      try {
        f.fit();
      } catch {
        return;
      }
      if (id) void invoke("terminal_resize", { id, cols: t.cols, rows: t.rows }).catch(() => {});
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Pin to the bottom as output streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !altScreen) el.scrollTop = el.scrollHeight;
  }, [blocks, altScreen]);

  const focusTerminalSurface = useCallback(() => {
    if (!isActive) return;
    onFocus();
    if (altScreen) {
      if (!surfaceReady) return;
      xtermRef.current?.focus();
    } else {
      commandInputRef.current?.focus();
    }
  }, [altScreen, isActive, onFocus, surfaceReady]);
  // Focus the right surface: xterm while an alt-screen app runs, else the input.
  useEffect(() => {
    if (!isActive) return;
    focusTerminalSurface();
  }, [isActive, altScreen, surfaceReady, focusTerminalSurface]);

  // External focus request (⌘J / focus-terminal shortcut).
  useEffect(() => {
    if (!pendingFocus || pendingFocus.tabId !== tabId || !isActive) return;
    focusPendingRef.current = true;
  }, [isActive, pendingFocus, tabId]);

  useEffect(() => {
    if (!focusPendingRef.current) return;
    if (!isActive || !surfaceReady) return;
    focusTerminalSurface();
    focusPendingRef.current = false;
    clearPendingTerminalFocus();
  }, [altScreen, clearPendingTerminalFocus, focusTerminalSurface, isActive, surfaceReady]);

  // A command is running when the live (last) block is still open. Surface it
  // as a spinner in the footer and report it to the tab strip via the store.
  const busy = useMemo(() => {
    const last = blocks[blocks.length - 1];
    return !!last && last.running && last.command !== "";
  }, [blocks]);

  useEffect(() => {
    useTerminalStore.getState().actions.setTerminalBusy(terminalKey, busy);
  }, [busy, terminalKey]);

  // Clear the busy flag when this terminal unmounts (tab/pane close).
  useEffect(() => {
    return () => {
      useTerminalStore.getState().actions.setTerminalBusy(terminalKey, false);
    };
  }, [terminalKey]);

  // Resolve git status for the live cwd (reuses the project git command).
  // Re-run when the directory changes or a command finishes (which may have
  // mutated the tree). Debounced so a burst of output doesn't thrash git.
  useEffect(() => {
    if (!cwd || cwd === "~") {
      setGit(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void invoke<RawGitStatus>("git_status_fresh", { path: cwd })
        .then((s) => {
          if (cancelled) return;
          setGit(
            s.is_repo
              ? { branch: s.branch, ahead: s.ahead, behind: s.behind, dirty: s.files.length > 0 }
              : null,
          );
        })
        .catch(() => {
          if (!cancelled) setGit(null);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [cwd, busy]);

  const runCommand = useCallback((cmd: string) => {
    const id = ptyRef.current;
    if (!id) return;
    // `clear` clears the React block list (the blocks are ours, not the shell's).
    // Send a bare newline so the shell redraws a fresh prompt.
    const trimmed = cmd.trim();
    if (trimmed === "clear") {
      parserRef.current?.clearBlocks();
      setBlocks([]);
      void invoke("terminal_write", { id, data: [0x0a] }).catch(() => {});
      return;
    }
    // Relaunch an interactive root shell with Atlas's zsh integration so blocks
    // / prompt markers keep working as root. $HOME is expanded by the root zsh.
    if (SUDO_SHELL_RE.test(trimmed) && zshDirRef.current) {
      const rewrite = `sudo zsh -c 'ZDOTDIR="${zshDirRef.current}" ATLAS_USER_ZDOTDIR="$HOME" exec zsh -i'`;
      void invoke("terminal_write", {
        id,
        data: Array.from(new TextEncoder().encode(rewrite + "\n")),
      }).catch(() => {});
      return;
    }
    void invoke("terminal_write", {
      id,
      data: Array.from(new TextEncoder().encode(cmd + "\n")),
    }).catch(() => {});
  }, []);

  const interrupt = useCallback(() => {
    const id = ptyRef.current;
    if (id) void invoke("terminal_write", { id, data: [0x03] }).catch(() => {});
  }, []);

  // Forward raw bytes to the PTY — used by the composer to feed nav keys to a
  // running interactive prompt (arrows / Tab / Esc).
  const writeRaw = useCallback((data: number[]) => {
    const id = ptyRef.current;
    if (id) void invoke("terminal_write", { id, data }).catch(() => {});
  }, []);

  // Send a secret typed into a block's inline password field straight to the
  // PTY (never shown in the command input or stored in history).
  const writePassword = useCallback((pw: string) => {
    const id = ptyRef.current;
    if (!id) return;
    void invoke("terminal_write", {
      id,
      data: Array.from(new TextEncoder().encode(pw + "\n")),
    }).catch(() => {});
  }, []);

  // ⌘F / Ctrl+F opens search over the block history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActive || altScreen) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearch((s) => ({ ...s, open: true }));
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, altScreen]);

  // Recount matches whenever the query or content changes.
  useEffect(() => {
    matchIdxRef.current = -1;
    const els = scrollRef.current?.querySelectorAll("[data-term-match]");
    setMatchCount(els ? els.length : 0);
  }, [search.query, blocks]);

  const navMatch = useCallback((dir: 1 | -1) => {
    const els = scrollRef.current?.querySelectorAll<HTMLElement>("[data-term-match]");
    if (!els || !els.length) return;
    matchIdxRef.current = (matchIdxRef.current + dir + els.length) % els.length;
    els.forEach((el) => el.classList.remove("term-match-active"));
    const el = els[matchIdxRef.current];
    el.classList.add("term-match-active");
    el.scrollIntoView({ block: "center" });
  }, []);

  const closeSearch = useCallback(() => {
    setSearch({ open: false, query: "" });
    commandInputRef.current?.focus();
  }, []);

  return (
    <div data-block-terminal className="relative flex h-full w-full flex-col bg-[var(--bg-base)]" onClick={onFocus}>
      {/* Interactive surface — overlays the block list while an alt-screen app runs. */}
      <div
        ref={xtermHostRef}
        className="absolute inset-0 z-10 bg-[#000] px-1 py-1"
        style={{
          visibility: altScreen ? "visible" : "hidden",
          pointerEvents: altScreen ? "auto" : "none",
        }}
      />

      {/* Search bar over the block history */}
      {search.open && !altScreen && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1 shadow-[var(--shadow-overlay)]">
          <Search size={12} className="shrink-0 text-[var(--text-tertiary)]" />
          <input
            ref={searchInputRef}
            value={search.query}
            onChange={(e) => setSearch((s) => ({ ...s, query: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
              else if (e.key === "Enter") navMatch(e.shiftKey ? -1 : 1);
            }}
            placeholder="Search output…"
            className="w-44 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-[var(--text-tertiary)]">
            {matchCount}
          </span>
          <button type="button" onClick={() => navMatch(-1)} className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ChevronUp size={13} />
          </button>
          <button type="button" onClick={() => navMatch(1)} className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ChevronDown size={13} />
          </button>
          <button type="button" onClick={closeSearch} className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Block list */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto hide-scrollbar px-3 py-2"
        style={{ visibility: altScreen ? "hidden" : "visible" }}
      >
        {blocks.map((b) => (
          <BlockCard key={b.id} block={b} onRerun={runCommand} onPassword={writePassword} query={search.query} />
        ))}
      </div>

      {/* Command input (hidden while an interactive app owns the screen).
          min-h-[28px] + items-center matches the neighbouring panel footers /
          the terminal pane header so the top borders line up. */}
      {!altScreen && (
        <div className="flex min-h-[28px] items-center gap-2 border-t border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-[5px]">
          {busy ? (
            <Loader2 size={13} className="shrink-0 animate-spin text-[var(--accent-primary)]" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-[var(--accent-primary)]" />
          )}
          <CommandInput
            ref={commandInputRef}
            onSubmit={runCommand}
            onInterrupt={interrupt}
            cwd={cwd}
            busy={busy}
            writeRaw={writeRaw}
          />
          <StatusBadge cwd={cwd} git={git} />
        </div>
      )}
    </div>
  );
}

/** Masked password entry rendered INLINE at the bottom of the running block
 *  whose output is a password prompt (sudo/ssh). Sent straight to the PTY. */
function BlockPasswordInput({ onSubmit }: { onSubmit: (pw: string) => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div className="flex items-center gap-2 border-t border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2">
      <Lock size={12} className="shrink-0 text-[var(--accent-primary)]" />
      <input
        ref={inputRef}
        type="password"
        value={value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
            setValue("");
          }
        }}
        autoComplete="off"
        spellCheck={false}
        placeholder="Enter password, then press Enter…"
        className="flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
        style={{ fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)' }}
      />
    </div>
  );
}

/** Right-aligned cwd + git status badge in the command input row. */
function StatusBadge({ cwd, git }: { cwd: string; git: TermGit | null }) {
  const dir = cwd ? cwd.split("/").filter(Boolean).pop() || "/" : "";
  if (!dir) return null;
  return (
    <div className="ml-auto flex shrink-0 items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
      <span className="flex items-center gap-1" title={cwd}>
        <Folder size={9} />
        {dir}
      </span>
      {git && (
        <>
          <span className="h-3 w-px bg-[var(--border-default)]" />
          <span className="flex items-center gap-1" title={`On branch ${git.branch}`}>
            <GitBranch size={9} />
            {git.branch || "(detached)"}
            {git.ahead > 0 && <span>↑{git.ahead}</span>}
            {git.behind > 0 && <span>↓{git.behind}</span>}
            {git.dirty && <span className="text-[var(--status-warning)]" title="Uncommitted changes">●</span>}
          </span>
        </>
      )}
    </div>
  );
}

function BlockCard({
  block,
  onRerun,
  onPassword,
  query,
}: {
  block: TerminalBlock;
  onRerun: (cmd: string) => void;
  onPassword: (pw: string) => void;
  query: string;
}) {
  // Render only the tail of very large output — segmenting + DOM-rendering a
  // multi-MB block would freeze the UI. The full (already store-capped) text is
  // still available via Copy.
  const RENDER_CAP = 96 * 1024;
  const clipped = block.output.length > RENDER_CAP;
  const display = clipped ? block.output.slice(-RENDER_CAP) : block.output;
  // `resolveTerminalOutput` applies CR / cursor / erase line discipline so a
  // spinner or progress bar that redraws the same line (`\r…`) collapses to one
  // updating line instead of concatenating every frame.
  const segments = useMemo(() => resolveTerminalOutput(display), [display]);
  const cwdName = block.cwd ? block.cwd.split("/").filter(Boolean).pop() : "";
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasHeader = block.command !== "";

  const duration =
    !block.running && block.endedAt ? formatDuration(block.endedAt - block.startedAt) : null;

  const copyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Copy the full stored output (not just the rendered tail).
    void navigator.clipboard.writeText(block.output).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group mb-2 overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-raised)]">
      {hasHeader && (
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 h-[28px] text-[12px]">
          {block.running ? (
            <Loader2 size={12} className="shrink-0 animate-spin text-[var(--accent-primary)]" />
          ) : block.exitCode && block.exitCode !== 0 ? (
            <XCircle size={12} className="shrink-0 text-[var(--status-error)]" />
          ) : (
            <CheckCircle2 size={12} className="shrink-0 text-[var(--status-success)]" />
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="truncate text-left font-mono text-[var(--text-primary)] hover:opacity-80"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {renderHL(block.command, query)}
          </button>

          {block.firehose && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-[var(--status-warning)]/15 px-1.5 py-0.5 text-[9px] text-[var(--status-warning)]"
              title="Large output — live view is throttled to keep the UI responsive"
            >
              {block.running ? "large output · throttled" : "large output"}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
            {/* Hover actions */}
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <BlockAction title={copied ? "Copied" : "Copy output"} onClick={copyOutput} icon={Copy} />
              <BlockAction title="Rerun" onClick={(e) => { e.stopPropagation(); onRerun(block.command); }} icon={RotateCw} />
              <BlockAction
                title={collapsed ? "Expand" : "Collapse"}
                onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
                icon={ChevronDown}
                rotated={collapsed}
              />
            </div>
            {cwdName && (
              <span className="flex items-center gap-1">
                <Folder size={9} />
                {cwdName}
              </span>
            )}
            {duration && <span>{duration}</span>}
            {!block.running && block.exitCode != null && block.exitCode !== 0 && (
              <span className="text-[var(--status-error)]">exit {block.exitCode}</span>
            )}
          </div>
        </div>
      )}
      {!collapsed && (clipped || block.truncated) && (
        <div className="px-3 pt-2 text-[10px] italic text-[var(--text-tertiary)]">
          earlier output hidden — showing the latest {Math.round(RENDER_CAP / 1024)} KB (Copy gets more)
        </div>
      )}
      {!collapsed && segments.length > 0 && (
        <BlockOutput segments={segments} cwd={block.cwd} query={query} />
      )}
      {block.awaitingPassword && block.running && (
        <BlockPasswordInput onSubmit={onPassword} />
      )}
    </div>
  );
}

function BlockAction({
  title,
  onClick,
  icon: Icon,
  rotated,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  icon: typeof Copy;
  rotated?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      <Icon size={11} className={cn("transition-transform", rotated && "-rotate-90")} />
    </button>
  );
}

function BlockOutput({ segments, cwd, query }: { segments: AnsiSegment[]; cwd: string; query: string }) {
  const openPath = useCallback(
    (raw: string) => {
      // Resolve to an absolute path, then open in Atlas if it's a kind we can
      // render, else reveal it in Finder.
      void invoke<string | null>("resolve_path", { base: cwd, raw })
        .then((abs) => {
          if (abs) void openFileOrReveal(abs);
        })
        .catch(() => {});
    },
    [cwd]
  );
  const openLink = useCallback((raw: string) => {
    void import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(normalizeUrl(raw)))
      .catch(() => {});
  }, []);

  return (
    <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-[1.45] text-[var(--text-secondary)]">
      {segments.flatMap((s, i) =>
        splitLinks(s.text).map((p, j) =>
          p.kind === "url" ? (
            <span
              key={`${i}-${j}`}
              style={s.style}
              title="⌘-click to open in browser"
              className="cursor-pointer hover:text-[var(--accent-primary)] hover:underline"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) openLink(p.text);
              }}
            >
              {renderHL(p.text, query)}
            </span>
          ) : p.kind === "path" ? (
            <span
              key={`${i}-${j}`}
              style={s.style}
              title="⌘-click to open"
              className="cursor-pointer hover:text-[var(--accent-primary)] hover:underline"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) openPath(p.text);
              }}
            >
              {renderHL(p.text, query)}
            </span>
          ) : (
            <span key={`${i}-${j}`} style={s.style}>
              {renderHL(p.text, query)}
            </span>
          )
        )
      )}
    </pre>
  );
}
