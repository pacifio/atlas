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
  Lock,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { openFileOrReveal } from "@/lib/open-file";
import { markScrollHot } from "@/lib/scroll-hot";
import { useAppStore } from "@/features/app/stores/app-store";
import { linkifySegments, normalizeUrl } from "../lib/linkify-paths";
import type { ResolvedLine } from "../lib/line-emulator";
import { perfBegin } from "../lib/term-perf";
import { formatDuration } from "../lib/format-duration";
import type { TerminalBlock } from "../lib/block-parser";
import { terminalSessions } from "../lib/terminal-session";
import { CommandInput, type CommandInputHandle } from "./command-input";
import { TerminalStopControl } from "./terminal-stop-control";
import { useTerminalStore } from "../stores/terminal-store";

export type { RawGitStatus } from "../lib/term-git";

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
        className="rounded-sm bg-[var(--atlas-status-warning-foreground)]/40 text-inherit"
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
        // A tab with its own directory (a session's terminal drawer) starts
        // there; a terminal tab follows the project.
        cwd:
          useTerminalStore.getState().cwds[tabId] ??
          useAppStore.getState().currentProject?.path ??
          "~",
      }),
    [terminalKey, tabId],
  );
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const { blocks, altScreen, rawMode, appCursorKeys, cwd, surfaceReady, exited } = snap;

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
  // Where the pin last put `scrollTop`. Assigning `scrollTop` dispatches a
  // `scroll` event like a user's scroll does; the handler has to tell the two
  // apart, or a terminal streaming output marks the app "scroll hot" on every
  // frame — which holds its own render to the parser's slow backstop and
  // throttles the agent chat and markdown rendering app-wide (`isScrollHot`).
  const pinTopRef = useRef(-1);
  const onBlocksScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop === pinTopRef.current) return;
    pinTopRef.current = -1;
    markScrollHot();
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
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
      if (!pinnedRef.current || altScreenRef.current) return;
      const bottom = el.scrollHeight - el.clientHeight;
      if (el.scrollTop === bottom) return;
      el.scrollTop = bottom;
      pinTopRef.current = el.scrollTop;
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
  const caps = useMemo(() => renderCaps(blocks), [blocks]);

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
      const cap = caps.get(b.id) ?? LIVE_RENDER_LINES;
      const lines = b.lines.length > cap ? b.lines.slice(-cap) : b.lines;
      for (const line of lines) {
        let text = "";
        for (const seg of line.segments) text += seg.text;
        count += countMatches(text.toLowerCase(), q);
      }
    }
    setMatchCount(count);
  }, [search.query, blocks, caps]);

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
      className="@container relative flex h-full w-full flex-col bg-[var(--background)]"
      onClick={onFocus}
    >
      {/* Interactive surface — overlays the block list while an alt-screen app runs. */}
      <div
        ref={xtermHostRef}
        // Keep Atlas's footer outside the app-controlled terminal viewport so
        // the stop control never covers top/htop clocks, menus, or editor UI.
        className="absolute inset-x-0 top-0 bottom-[29px] z-10 bg-[var(--atlas-terminal-background)] px-1 py-1"
        style={{
          visibility: altScreen ? "visible" : "hidden",
          pointerEvents: altScreen ? "auto" : "none",
        }}
      />

      {/* Search bar over the block history */}
      {search.open && !altScreen && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--popover)] px-2 py-1 shadow-md">
          <Search size={12} className="shrink-0 text-[var(--muted-foreground)]" />
          <input
            ref={searchInputRef}
            value={search.query}
            onChange={(e) => setSearch((s) => ({ ...s, query: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
              else if (e.key === "Enter") navMatch(e.shiftKey ? -1 : 1);
            }}
            placeholder="Search output…"
            className="w-44 bg-transparent text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
          />
          <span className="w-10 shrink-0 text-right text-2xs tabular-nums text-[var(--muted-foreground)]">
            {matchCount}
          </span>
          <HintGroup>
            <HintItem label="Previous match">
              <button
                type="button"
                onClick={() => navMatch(-1)}
                className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
              >
                <ChevronUp size={13} />
              </button>
            </HintItem>
            <HintItem label="Next match">
              <button
                type="button"
                onClick={() => navMatch(1)}
                className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
              >
                <ChevronDown size={13} />
              </button>
            </HintItem>
            <HintItem label="Close search">
              <button
                type="button"
                onClick={closeSearch}
                className="rounded p-0.5 text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
              >
                <X size={13} />
              </button>
            </HintItem>
          </HintGroup>
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
              cap={caps.get(b.id) ?? LIVE_RENDER_LINES}
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
      <div className="relative z-20 flex min-h-[29px] items-center gap-2 border-t border-[var(--border)] bg-[var(--background)] px-3 py-[5px]">
        {busy || altScreen ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-[var(--primary)]" />
        ) : (
          <ChevronRight size={13} className="shrink-0 text-[var(--primary)]" />
        )}
        {exited ? (
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted-foreground)]">
            Shell exited — close this terminal or open a new one
          </span>
        ) : altScreen ? (
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--muted-foreground)]">
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
    <div className="flex items-center gap-2 border-t border-[var(--atlas-border-subtle)] bg-[var(--background)] px-3 py-2">
      <Lock size={12} className="shrink-0 text-[var(--primary)]" />
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
        className="flex-1 bg-transparent font-terminal text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
      />
    </div>
  );
}

// Lines rendered per block. The emulator already bounds a block at MAX_LINES;
// this is the DOM budget. A RUNNING block shows a shorter tail because its hot
// rows are rebuilt every flush — the full depth appears the moment it finishes.
const LIVE_RENDER_LINES = 400;
const FINISHED_RENDER_LINES = 3000;
// Lines rendered across ALL finished blocks of one terminal, newest first.
// Per-block caps alone let 200 blocks × 3000 lines stay mounted — hundreds of
// thousands of nodes, every one rebuilt when the terminal tab is shown again
// and every one in the way of each forced layout (typing in the input, the
// suggestions popup). Older blocks past the budget keep their header and
// collapse their body behind "show"; Copy and search still read the data.
const FINISHED_RENDER_BUDGET = 4000;

/** Lines each block may render. Finished blocks only spend the budget: their
 *  line counts are fixed, so a cap moves only when a block finishes or is
 *  added — never per streaming flush, which would re-render every card. */
export function renderCaps(blocks: readonly TerminalBlock[]): Map<number, number> {
  const caps = new Map<number, number>();
  let left = FINISHED_RENDER_BUDGET;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.running) {
      caps.set(b.id, LIVE_RENDER_LINES);
      continue;
    }
    const cap = Math.min(FINISHED_RENDER_LINES, b.lines.length, left);
    caps.set(b.id, cap);
    left -= cap;
  }
  return caps;
}

/** Memoized: block objects mutate in place while running, so `rev` (bumped by
 *  the parser once per flush) is what invalidates a card. Finished blocks never
 *  re-render during streaming — the per-flush cost is one live card, and inside
 *  it only the hot lines (see `OutputLine`). */
const BlockCard = memo(function BlockCard({
  block,
  rev,
  cap: budgetCap,
  onRerun,
  onPassword,
  query,
}: {
  block: TerminalBlock;
  rev: number;
  /** Lines this card may render — its share of the terminal's budget. */
  cap: number;
  onRerun: (cmd: string) => void;
  onPassword: (pw: string) => void;
  query: string;
}) {
  void rev; // memo key only
  // "Show" on a card the budget emptied lifts it to the per-block cap.
  const [expanded, setExpanded] = useState(false);
  const cap = expanded ? Math.max(budgetCap, FINISHED_RENDER_LINES) : budgetCap;
  const lines = block.lines;
  const visible = lines.length > cap ? lines.slice(-cap) : lines;
  const hidden = block.droppedLines + (lines.length - visible.length);
  const budgeted = !block.running && visible.length === 0 && lines.length > 0;
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
  if (!hasHeader && lines.length === 0 && !block.awaitingPassword) return null;

  const copyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Copy the full stored output (not just the rendered tail).
    void navigator.clipboard.writeText(block.output).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div
      className="group mb-2 overflow-hidden rounded-md border border-[var(--border)] bg-[var(--card)]"
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
        <div className="flex items-center gap-2 border-b border-[var(--atlas-border-subtle)] px-2.5 h-control-md text-sm">
          {block.running ? (
            <Loader2 size={12} className="shrink-0 animate-spin text-[var(--primary)]" />
          ) : block.exitCode && block.exitCode !== 0 ? (
            <XCircle size={12} className="shrink-0 text-[var(--atlas-status-error-foreground)]" />
          ) : (
            <CheckCircle2
              size={12}
              className="shrink-0 text-[var(--atlas-status-success-foreground)]"
            />
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="truncate text-left font-mono text-[var(--foreground)] hover:opacity-80"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {renderHL(block.command, query)}
          </button>

          {block.firehose && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-[var(--atlas-status-warning-foreground)]/15 px-1.5 py-0.5 text-3xs text-[var(--atlas-status-warning-foreground)]"
              title="Large output — live view is throttled to keep the UI responsive"
            >
              {block.running ? "large output · throttled" : "large output"}
            </span>
          )}

          <div className="ml-auto flex items-center gap-2 text-2xs text-[var(--muted-foreground)]">
            {/* Hover actions */}
            <HintGroup>
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
            </HintGroup>
            {cwdName && (
              <span className="flex items-center gap-1">
                <Folder size={9} />
                {cwdName}
              </span>
            )}
            {duration && <span>{duration}</span>}
            {!block.running && block.exitCode != null && block.exitCode !== 0 && (
              <span className="text-[var(--atlas-status-error-foreground)]">
                exit {block.exitCode}
              </span>
            )}
          </div>
        </div>
      )}
      {!collapsed && budgeted && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(true);
          }}
          className="w-full px-3 py-1.5 text-left text-2xs italic text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          {lines.length} lines hidden to keep the terminal fast — show
        </button>
      )}
      {!collapsed && !budgeted && (hidden > 0 || block.truncated) && (
        <div className="px-3 pt-2 text-2xs italic text-[var(--muted-foreground)]">
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
    <HintItem label={title}>
      <button
        type="button"
        onClick={onClick}
        className="flex h-5 w-5 items-center justify-center rounded text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
      >
        <Icon size={11} className={cn("transition-transform", rotated && "-rotate-90")} />
      </button>
    </HintItem>
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
    // `atlas-terminal-output`: `terminalFontSize` less a pixel (globals.css).
    <div className="atlas-terminal-output select-text whitespace-pre-wrap break-words px-3 py-2 font-terminal leading-[1.4] text-[var(--secondary-foreground)]">
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
            className="cursor-pointer hover:text-[var(--primary)] hover:underline"
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
            className="cursor-pointer hover:text-[var(--primary)] hover:underline"
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
