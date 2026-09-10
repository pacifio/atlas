import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronRight,
  Folder,
  Copy,
  RotateCw,
  ChevronDown,
  ChevronUp,
  Search,
  X,
  GitBranch,
  Lock,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { openFileOrReveal } from "@/lib/open-file";
import { markScrollHot } from "@/lib/scroll-hot";
import { useProjectStore } from "@/features/project/stores/project-store";
import { linkifySegments, normalizeUrl } from "../lib/linkify-paths";
import type { ResolvedLine } from "../lib/line-emulator";
import { perfBegin } from "../lib/term-perf";
import { formatDuration } from "../lib/format-duration";
import type { TerminalBlock } from "../lib/block-parser";
import { terminalSessions } from "../lib/terminal-session";
import { CommandInput, type CommandInputHandle } from "./command-input";
import { TerminalStopControl } from "./terminal-stop-control";
import { useTerminalStore } from "../stores/terminal-store";

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

/** Non-overlapping occurrences of `q` in `lower` (both already lower-cased). */
function countMatches(lower: string, q: string): number {
  let n = 0;
  let i = lower.indexOf(q);
  while (i >= 0) {
    n++;
    i = lower.indexOf(q, i + q.length);
  }
  return n;
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
      <mark
        key={k++}
        data-term-match
        className="rounded-[2px] bg-[var(--status-warning)]/40 text-inherit"
      >
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return nodes;
}

interface BlockTerminalProps {
  /** This terminal owns keyboard focus (active in its pane, pane active). */
  isActive: boolean;
  /** This terminal is on screen: its tab is the active tab of its column and
   *  it is the active terminal of its pane. Drives the session's render gate. */
  visible: boolean;
  onFocus: () => void;
  /** The terminal tab id (layout/terminal store), used to bind pending focus
   *  requests to the correct terminal tab. */
  tabId: string;
  /** The layout terminal id (terminal-store) — the session registry's key. */
  terminalKey: string;
}

/**
 * Block terminal — the VIEW over a `TerminalSession`.
 *
 * The session (PTY, parser, xterm) lives in `terminal-session.ts` and outlives
 * this component; mounting attaches a view, unmounting detaches it. Nothing
 * here closes a shell — the registry does that when the terminal leaves the
 * store. The PTY (zsh shell integration) streams into the parser, which
 * segments normal command output into React "blocks" and forwards only what
 * an alt-screen app needs to the embedded xterm (shown when one is running).
 */
export const BlockTerminal = memo(function BlockTerminal({
  isActive,
  visible,
  onFocus,
  tabId,
  terminalKey,
}: BlockTerminalProps) {
  const session = useMemo(
    () =>
      terminalSessions.acquire(terminalKey, {
        tabId,
        cwd: useProjectStore.getState().currentProject?.path ?? "~",
      }),
    [terminalKey, tabId],
  );
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { blocks, altScreen, rawMode, appCursorKeys, cwd, surfaceReady, exited } = snap;

  const [git, setGit] = useState<TermGit | null>(null);
  const [search, setSearch] = useState({ open: false, query: "" });
  const [matchCount, setMatchCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const matchIdxRef = useRef(-1);
  const focusPendingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<CommandInputHandle>(null);
  const xtermHostRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const pendingFocus = useTerminalStore((s) => s.pendingFocus);
  const { clearPendingTerminalFocus } = useTerminalStore.use.actions();

  // Attach the session's surface to this view's host; detach on unmount. The
  // surface element is the session's, so a remount re-parents it and nothing
  // xterm drew is lost.
  useLayoutEffect(() => {
    const host = xtermHostRef.current;
    if (!host) return;
    return session.attach(host);
  }, [session]);

  // The render gate: hidden views cost the session nothing.
  useEffect(() => {
    session.setVisible(visible);
    return () => session.setVisible(false);
  }, [session, visible]);

  // Close the dev flush measurement once React has committed the new blocks.
  useEffect(() => {
    session.committed();
  }, [session, blocks]);

  // Keep the PTY sized to the view. The session coalesces, deduplicates and
  // defers while the box is not real (hidden tab → 0×0).
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => session.requestFit());
    ro.observe(el);
    session.requestFit();
    return () => ro.disconnect();
  }, [session]);

  // Pin to the bottom as output streams — but ONLY while the user is at the
  // bottom. The old unconditional pin yanked the viewport back down on every
  // 16 ms flush, making it impossible to scroll up during a long command.
  const pinnedRef = useRef(true);
  const onBlocksScroll = useCallback(() => {
    markScrollHot();
    const el = scrollRef.current;
    if (el) {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    }
  }, []);
  // Re-pin when the CONTENT grows, from a ResizeObserver — never from the
  // render path. The old effect read `scrollHeight` and wrote `scrollTop` on
  // every flush, which forced a synchronous layout of every mounted block
  // inside the commit. RO callbacks run after layout in the frame, so the read
  // is free, and they fire only when something actually changed height.
  // (`overflow-anchor` would be the declarative answer; WebKit lacks it.)
  const contentRef = useRef<HTMLDivElement>(null);
  const altScreenRef = useRef(altScreen);
  altScreenRef.current = altScreen;
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current && !altScreenRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  const focusTerminalSurface = useCallback(() => {
    if (!isActive || !visible) return;
    onFocus();
    if (altScreen) {
      if (!surfaceReady) return;
      session.focusXterm();
    } else {
      commandInputRef.current?.focus();
    }
  }, [altScreen, isActive, visible, onFocus, session, surfaceReady]);
  // Focus the right surface: xterm while an alt-screen app runs, else the input.
  useEffect(() => {
    if (!isActive || !visible) return;
    focusTerminalSurface();
  }, [isActive, visible, altScreen, surfaceReady, focusTerminalSurface]);

  // External focus request (⌘J / focus-terminal shortcut / a notification).
  useEffect(() => {
    if (!pendingFocus || pendingFocus.tabId !== tabId || !isActive) return;
    focusPendingRef.current = true;
  }, [isActive, pendingFocus, tabId]);

  useEffect(() => {
    if (!focusPendingRef.current) return;
    if (!isActive || !visible) return;
    if (altScreen && !surfaceReady) return;
    focusTerminalSurface();
    focusPendingRef.current = false;
    clearPendingTerminalFocus();
  }, [altScreen, clearPendingTerminalFocus, focusTerminalSurface, isActive, visible, surfaceReady]);

  // A command is running when the live (last) block is still open. The
  // session reports it to the tab strip; this is for the footer spinner.
  const busy = useMemo(() => {
    const last = blocks[blocks.length - 1];
    return !!last && last.running && last.command !== "";
  }, [blocks]);

  // Resolve git status for the live cwd (reuses the project git command).
  // Re-run when the directory changes or a command finishes (which may have
  // mutated the tree). Debounced so a burst of output doesn't thrash git.
  useEffect(() => {
    if (!visible || !cwd || cwd === "~") {
      if (!cwd || cwd === "~") setGit(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void invoke<RawGitStatus>("git_status_fresh", { path: cwd })
        .then((s) => {
          if (cancelled) return;
          setGit(
            s.is_repo
              ? {
                  branch: s.branch,
                  ahead: s.ahead,
                  behind: s.behind,
                  dirty: s.files.length > 0,
                }
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
  }, [cwd, busy, visible]);

  const runCommand = useCallback((cmd: string) => session.runCommand(cmd), [session]);
  const interrupt = useCallback(() => session.interrupt(), [session]);
  const forceStop = useCallback(() => session.killForeground(), [session]);
  const restoreBlockSurface = useCallback(() => session.restoreBlockSurface(), [session]);
  const writeRaw = useCallback((data: number[]) => session.writeRaw(data), [session]);
  const writePassword = useCallback((pw: string) => session.writePassword(pw), [session]);

  // ⌘F arrives through the keybinding layer (`terminal.find`, scoped to the
  // focused terminal panel) as a bumped `searchRequest` on the session — never
  // a window listener per terminal, which had every mounted terminal, hidden
  // ones included, answering the same chord.
  const lastSearchReq = useRef(snap.searchRequest);
  useEffect(() => {
    if (snap.searchRequest === lastSearchReq.current) return;
    lastSearchReq.current = snap.searchRequest;
    if (!visible || altScreen) return;
    setSearch((s) => ({ ...s, open: true }));
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [snap.searchRequest, visible, altScreen]);

  // Match count from the DATA, not the DOM: a `querySelectorAll` over every
  // mounted block per flush scaled with the whole history while search was
  // open. This walks the resolved lines instead (the same text the DOM shows,
  // capped like the DOM is) and only when there is a query.
  useEffect(() => {
    matchIdxRef.current = -1;
    if (!search.query) {
      setMatchCount(0);
      return;
    }
    const q = search.query.toLowerCase();
    let count = 0;
    for (const b of blocks) {
      count += countMatches(b.command.toLowerCase(), q);
      const cap = b.running ? LIVE_RENDER_LINES : FINISHED_RENDER_LINES;
      const lines = b.lines.length > cap ? b.lines.slice(-cap) : b.lines;
      for (const line of lines) {
        let text = "";
        for (const seg of line.segments) text += seg.text;
        count += countMatches(text.toLowerCase(), q);
      }
    }
    setMatchCount(count);
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
    <div
      ref={rootRef}
      data-block-terminal
      // `@container` so the input-row badges respond to the PANE's width, not
      // the window's — split panes make viewport media queries meaningless.
      className="@container relative flex h-full w-full flex-col bg-[var(--bg-base)]"
      onClick={onFocus}
    >
      {/* Interactive surface — overlays the block list while an alt-screen app runs. */}
      <div
        ref={xtermHostRef}
        // Keep Atlas's footer outside the app-controlled terminal viewport so
        // the stop control never covers top/htop clocks, menus, or editor UI.
        className="absolute inset-x-0 top-0 bottom-[29px] z-10 bg-[#000] px-1 py-1"
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
          <button
            type="button"
            onClick={() => navMatch(-1)}
            className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ChevronUp size={13} />
          </button>
          <button
            type="button"
            onClick={() => navMatch(1)}
            className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            onClick={closeSearch}
            className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Block list */}
      <div
        ref={scrollRef}
        onScroll={onBlocksScroll}
        className="min-h-0 flex-1 overflow-y-auto hide-scrollbar px-3 py-2"
        style={{ visibility: altScreen ? "hidden" : "visible" }}
      >
        <div ref={contentRef}>
          {blocks.map((b) => (
            <BlockCard
              key={b.id}
              block={b}
              rev={b.rev}
              onRerun={runCommand}
              onPassword={writePassword}
              query={search.query}
            />
          ))}
        </div>
      </div>

      {/* Atlas-owned footer stays visible below both block and alternate-screen
          modes. Keeping process controls outside the PTY viewport prevents them
          from obscuring application content. */}
      <div className="relative z-20 flex min-h-[29px] items-center gap-2 border-t border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-[5px]">
        {busy || altScreen ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-[var(--accent-primary)]" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-[var(--accent-primary)]" />
        )}
        {exited ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-tertiary)]">
            Shell exited — close this terminal or open a new one
          </span>
        ) : altScreen ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-tertiary)]">
            Interactive process
          </span>
        ) : (
          <CommandInput
            ref={commandInputRef}
            onSubmit={runCommand}
            onInterrupt={interrupt}
            cwd={cwd}
            busy={busy}
            rawMode={rawMode}
            appCursorKeys={appCursorKeys}
            writeRaw={writeRaw}
          />
        )}
        <TerminalStopControl
          active={busy || altScreen}
          onInterrupt={interrupt}
          onForceStop={forceStop}
          onForceStopped={restoreBlockSurface}
        />
        {/* Divider between the stop control and the cwd/git badge — same rule
            the badge draws between its dir and branch segments. Only when both
            neighbours are visible: stop control needs `busy`, the badge hides
            in alt-screen and below the 300px container query. */}
        {busy && !altScreen && (
          <span className="hidden h-3 w-px shrink-0 bg-[var(--border-default)] @[300px]:block" />
        )}
        {!altScreen && <StatusBadge cwd={cwd} git={git} />}
      </div>
    </div>
  );
});

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
    // Progressive disclosure as the PANE narrows (container query against the
    // terminal root): the git segment goes first, then the whole badge, so the
    // command input always keeps usable width. Long dir/branch names truncate.
    <div className="ml-auto hidden shrink-0 items-center gap-2 text-[10px] text-[var(--text-tertiary)] @[300px]:flex">
      <span className="flex min-w-0 items-center gap-1" title={cwd}>
        <Folder size={9} className="shrink-0" />
        <span className="max-w-[96px] truncate">{dir}</span>
      </span>
      {git && (
        <>
          <span className="hidden h-3 w-px bg-[var(--border-default)] @[420px]:block" />
          <span
            className="hidden min-w-0 items-center gap-1 @[420px]:flex"
            title={`On branch ${git.branch}`}
          >
            <GitBranch size={9} className="shrink-0" />
            <span className="max-w-[140px] truncate">{git.branch || "(detached)"}</span>
            {git.ahead > 0 && <span>↑{git.ahead}</span>}
            {git.behind > 0 && <span>↓{git.behind}</span>}
            {git.dirty && (
              <span className="text-[var(--status-warning)]" title="Uncommitted changes">
                ●
              </span>
            )}
          </span>
        </>
      )}
    </div>
  );
}

// Lines rendered per block. The emulator already bounds a block at MAX_LINES;
// this is the DOM budget. A RUNNING block shows a shorter tail because its hot
// rows are rebuilt every flush — the full depth appears the moment it finishes.
const LIVE_RENDER_LINES = 400;
const FINISHED_RENDER_LINES = 3000;

/** Memoized: block objects mutate in place while running, so `rev` (bumped by
 *  the parser once per flush) is what invalidates a card. Finished blocks never
 *  re-render during streaming — the per-flush cost is one live card, and inside
 *  it only the hot lines (see `OutputLine`). */
const BlockCard = memo(function BlockCard({
  block,
  rev,
  onRerun,
  onPassword,
  query,
}: {
  block: TerminalBlock;
  rev: number;
  onRerun: (cmd: string) => void;
  onPassword: (pw: string) => void;
  query: string;
}) {
  void rev; // memo key only
  const cap = block.running ? LIVE_RENDER_LINES : FINISHED_RENDER_LINES;
  const lines = block.lines;
  const visible = lines.length > cap ? lines.slice(-cap) : lines;
  const hidden = block.droppedLines + (lines.length - visible.length);
  const cwdName = block.cwd ? block.cwd.split("/").filter(Boolean).pop() : "";
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasHeader = block.command !== "";

  const duration =
    !block.running && block.endedAt ? formatDuration(block.endedAt - block.startedAt) : null;

  // An EMPTY headerless block is the preamble waiting for the shell's first
  // prompt marker (zsh sourcing a profile takes a few seconds). Rendering its
  // card then paints a bordered box with nothing in it — a stray grey line at
  // the top of a fresh terminal. Nothing to show, so show nothing.
  if (!hasHeader && visible.length === 0 && !block.awaitingPassword) return null;

  const copyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Copy the full stored output (not just the rendered tail).
    void navigator.clipboard.writeText(block.output).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      className="group mb-2 overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-raised)]"
      // A finished block skips layout and paint while off screen — without a
      // virtualizer and without promoting a layer (Safari 18+; older WebKit
      // ignores it). Never on the live card: its height changes every flush
      // and the intrinsic-size placeholder would fight the auto-scroll.
      style={
        block.running
          ? undefined
          : { contentVisibility: "auto", containIntrinsicSize: "auto 200px" }
      }
    >
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
              <BlockAction
                title={copied ? "Copied" : "Copy output"}
                onClick={copyOutput}
                icon={Copy}
              />
              <BlockAction
                title="Rerun"
                onClick={(e) => {
                  e.stopPropagation();
                  onRerun(block.command);
                }}
                icon={RotateCw}
              />
              <BlockAction
                title={collapsed ? "Expand" : "Collapse"}
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsed((c) => !c);
                }}
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
      {!collapsed && (hidden > 0 || block.truncated) && (
        <div className="px-3 pt-2 text-[10px] italic text-[var(--text-tertiary)]">
          earlier output hidden — showing the latest {visible.length} lines (Copy gets more)
        </div>
      )}
      {!collapsed && visible.length > 0 && (
        <LineList lines={visible} cwd={block.cwd} query={query} />
      )}
      {block.awaitingPassword && block.running && <BlockPasswordInput onSubmit={onPassword} />}
    </div>
  );
});

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

/** The block's output as one element per resolved line. Committed lines keep
 *  their object identity across flushes, so `OutputLine`'s memo bails for all
 *  but the handful of hot rows at the tail — linkification and span creation
 *  happen once per line for its lifetime. */
const LineList = memo(function LineList({
  lines,
  cwd,
  query,
}: {
  lines: readonly ResolvedLine[];
  cwd: string;
  query: string;
}) {
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
    [cwd],
  );
  const openLink = useCallback((raw: string) => {
    void import("@tauri-apps/plugin-opener")
      .then(({ openUrl }) => openUrl(normalizeUrl(raw)))
      .catch(() => {});
  }, []);

  return (
    // Block-level children: WebKit still inserts a newline between them on
    // copy, so selecting across lines pastes as it reads.
    // `select-text`: globals.css turns text selection OFF for the whole app
    // and back on only for inputs, `pre`, `code` and this class. This surface
    // used to be a `<pre>` and got selection for free; the line emulator
    // rework made it a `<div>` and selection silently died with the tag.
    <div className="select-text whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-[1.45] text-[var(--text-secondary)]">
      {lines.map((line) => (
        <OutputLine
          key={line.id}
          line={line}
          query={query}
          onOpenPath={openPath}
          onOpenLink={openLink}
        />
      ))}
    </div>
  );
});

const OutputLine = memo(function OutputLine({
  line,
  query,
  onOpenPath,
  onOpenLink,
}: {
  line: ResolvedLine;
  query: string;
  onOpenPath: (raw: string) => void;
  onOpenLink: (raw: string) => void;
}) {
  // Line-level linkification (a URL styled across several SGR runs — e.g.
  // Vite's `http://localhost:` + `8080/` — is one clickable target). Keyed on
  // the segments' identity: a committed line never recomputes.
  const end = perfBegin("linkify");
  const runs = useMemo(() => linkifySegments(line.segments), [line.segments]);
  end();
  // An empty line still needs height.
  if (runs.length === 0) return <div>{"\u200b"}</div>;
  return (
    <div>
      {runs.map((r, i) =>
        r.kind === "url" ? (
          <span
            key={i}
            style={r.style}
            title="⌘-click to open in browser"
            className="cursor-pointer hover:text-[var(--accent-primary)] hover:underline"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) onOpenLink(r.target ?? r.text);
            }}
          >
            {renderHL(r.text, query)}
          </span>
        ) : r.kind === "path" ? (
          <span
            key={i}
            style={r.style}
            title="⌘-click to open"
            className="cursor-pointer hover:text-[var(--accent-primary)] hover:underline"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey) onOpenPath(r.target ?? r.text);
            }}
          >
            {renderHL(r.text, query)}
          </span>
        ) : (
          <span key={i} style={r.style}>
            {renderHL(r.text, query)}
          </span>
        ),
      )}
    </div>
  );
});
