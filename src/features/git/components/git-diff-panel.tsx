import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronUp,
  ChevronDown,
  RefreshCw,
  ExternalLink,
  FileCode2,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openFile } from "@/lib/open-file";
import { getLanguage } from "../lib/diff";
import {
  ensureDiffHighlight,
  getCachedHighlight,
  warmDiffHighlightWorker,
  type LineTokens,
} from "../lib/diff-highlight-cache";
import {
  gitDiffStructured,
  diffStructuredText,
  diffQueryKey,
  type DiffSide,
  type DiffRow,
} from "../lib/git-diff-api";
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from "react-resizable-panels";
import { useGitStore } from "../stores/git-store";
import { ChangedFilesTree } from "./changed-files-tree";
import { DiffMinimap } from "./diff-minimap";

// Match the CodeMirror editor's metrics (editor-panel.tsx: 14px / 18px) so the
// diff reads at the same scale as the code editor.
const ROW_H = 18;
const FONT_PX = 14;
const CENTER_W = 12; // center gutter: change-direction chevron (tight)
const RADIUS = 5;
const LINE_NO_W = 32; // `w-8` line-number gutter inside each SideCell
const CODE_PAD = 16; // `pl-2 pr-2` on the code cell

/** Width of one monospace character at `FONT_PX`, measured once. Nudged +2%
 *  so the computed column always errs slightly WIDE (a hair of trailing scroll)
 *  rather than narrow (which would clip the longest line). */
let cachedCharW = 0;
function monoCharWidth(): number {
  if (cachedCharW) return cachedCharW;
  let w = FONT_PX * 0.6;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      // Mirror the diff's `font-mono` stack at FONT_PX.
      ctx.font = `${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace`;
      const m = ctx.measureText("MMMMMMMMMMMMMMMMMMMM").width / 20;
      if (m > 0) w = m;
    }
  } catch {
    /* headless / no canvas — fall back to the ratio */
  }
  cachedCharW = w * 1.02;
  return cachedCharW;
}

/** Character length of a diff side's rendered line (sum of its segments). */
function sideLen(side: DiffSide | null): number {
  if (!side) return 0;
  let n = 0;
  for (const s of side.segments) n += s.text.length;
  return n;
}

// Kept from the v3 `autoSaveId` so existing saved tree widths still load.
const TREE_LAYOUT_ID = "git-diff-tree";

interface GitDiffPanelProps {
  /** Falls back to the active repo when opened as a standalone module. */
  repoPath?: string;
  /** Empty when opened as a module — the tree is shown and the pane prompts. */
  file?: string;
  staged?: boolean;
  /** When set, the diff for this file at a specific commit (via `git show`). */
  commit?: string | null;
  /** Hide the tree's commit/branch picker — see `ChangedFilesTree.hidePicker`. */
  hidePicker?: boolean;
  /** Restrict the tree to these repo-relative paths — see
   *  `ChangedFilesTree.only`. */
  only?: string[];
  /**
   * Before/after text per path, bypassing git entirely.
   *
   * The agent chat needs this. A turn's diff is not a question git can answer:
   * the working tree holds the CURRENT state, while a file created in turn 1,
   * edited in turn 2 and deleted in turn 3 has three different correct diffs and
   * only the tool arguments know which. When a path appears here, its diff is
   * computed from these strings instead of from the repository.
   */
  textSources?: Record<string, { old: string; new: string }>;
  /** Handle tree clicks instead of opening the Git Diff module tab — see
   *  `ChangedFilesTree.onSelect`. */
  onSelectFile?: (path: string) => void;
  /** Fired after "Open in editor" — a modal host closes itself here, or the
   *  editor tab lands invisibly behind it. */
  onOpenInEditor?: () => void;
}

function sideBg(side: DiffSide | null, isLeft: boolean): string | undefined {
  if (!side) return "rgba(255,255,255,0.018)"; // filler (no line on this side)
  if (side.kind === "context") return undefined;
  // Left side = deletions (red), right side = additions (green). Colors follow
  // the active editor theme's diff tokens (atlas rgba values as fallbacks).
  return isLeft
    ? "var(--diff-remove-side-bg, rgba(244,63,63,0.13))"
    : "var(--diff-add-side-bg, rgba(34,197,94,0.13))";
}

function emphBg(isLeft: boolean): string {
  return isLeft
    ? "var(--diff-emph-remove-bg, rgba(244,63,63,0.34))"
    : "var(--diff-emph-add-bg, rgba(52,211,153,0.34))";
}

const isLeftChange = (r?: DiffRow) => !!r?.left && r.left.kind !== "context";
const isRightChange = (r?: DiffRow) => !!r?.right && r.right.kind !== "context";

/** Render one line as syntax-highlighted spans, with word-level changed spans
 *  overlaid as a background mark. Merges the (foreground) highlight.js tokens
 *  with the (background) emphasis ranges at the character level. */
function CellContent({
  side,
  hlMap,
  isLeft,
}: {
  side: DiffSide;
  hlMap: LineTokens | null;
  isLeft: boolean;
}) {
  const text = side.segments.map((s) => s.text).join("");
  // Per-char emphasis flags from the engine's word-diff segments.
  const emph = new Uint8Array(text.length);
  let o = 0;
  for (const s of side.segments) {
    if (s.emph) for (let i = 0; i < s.text.length; i++) emph[o + i] = 1;
    o += s.text.length;
  }
  // Precomputed off-thread (see diff-highlight-cache). `undefined` = not ready
  // yet, `null` = computed-but-plain — both render raw text; the row upgrades to
  // colored once the worker resolves and `hlMap` changes identity.
  const tokens = hlMap?.get(text) ?? [{ text, cls: null }];

  const spans: React.ReactNode[] = [];
  let pos = 0;
  let key = 0;
  for (const t of tokens) {
    let i = 0;
    while (i < t.text.length) {
      const e = emph[pos + i];
      let j = i + 1;
      while (j < t.text.length && emph[pos + j] === e) j++;
      const slice = t.text.slice(i, j);
      spans.push(
        <span
          key={key++}
          className={t.cls ?? undefined}
          style={e ? { background: emphBg(isLeft), borderRadius: 2 } : undefined}
        >
          {slice}
        </span>,
      );
      i = j;
    }
    pos += t.text.length;
  }
  return <>{spans}</>;
}

function SideCell({
  side,
  hlMap,
  isLeft,
  roundTop,
  roundBot,
}: {
  side: DiffSide | null;
  hlMap: LineTokens | null;
  isLeft: boolean;
  roundTop: boolean;
  roundBot: boolean;
}) {
  const bg = sideBg(side, isLeft);
  return (
    <div className="flex min-w-0">
      <span className="w-8 shrink-0 select-none border-r border-[var(--border-subtle)] pr-[3px] pl-[3px] text-right font-mono text-[10px] leading-[18px] text-[var(--text-tertiary)]">
        {side?.lineNo ?? ""}
      </span>
      <code
        className="diff-syntax block flex-1 overflow-hidden whitespace-pre pl-2 pr-2 font-mono leading-[18px] text-[var(--text-secondary)]"
        style={{
          fontSize: FONT_PX,
          background: bg,
          borderTopLeftRadius: roundTop ? RADIUS : 0,
          borderTopRightRadius: roundTop ? RADIUS : 0,
          borderBottomLeftRadius: roundBot ? RADIUS : 0,
          borderBottomRightRadius: roundBot ? RADIUS : 0,
        }}
      >
        {side ? (
          // Panned horizontally by the shared `--diff-sx` (set on the scroll
          // container). `inline-block` sizes to the line so long content can
          // slide left/right inside the fixed, clipped cell.
          <span
            className="inline-block"
            style={{
              transform: "translateX(calc(var(--diff-sx, 0px) * -1))",
            }}
          >
            <CellContent side={side} hlMap={hlMap} isLeft={isLeft} />
          </span>
        ) : null}
      </code>
    </div>
  );
}

/** Center connector: chevron + tint linking a change across the two panes,
 *  evoking JetBrains' diff gutter. */
function CenterMarker({ row }: { row: DiffRow }) {
  const lc = isLeftChange(row);
  const rc = isRightChange(row);
  let char = "";
  let color = "var(--text-tertiary)";
  if (lc && rc) {
    char = "›";
  } else if (rc) {
    char = "»";
    color = "var(--status-success, #22c55e)";
  } else if (lc) {
    char = "«";
    color = "var(--status-error, #ef4444)";
  }
  return (
    <div
      className="flex items-center justify-center border-x border-[var(--border-subtle)] font-mono text-[11px] leading-[18px] select-none"
      style={{ color }}
    >
      {char}
    </div>
  );
}

/**
 * One side-by-side diff row, wrapped in `memo`. This is THE scroll-performance
 * lever: the virtualizer re-renders the whole list on every scroll frame, but
 * its props here (`row`/`prev`/`next` are stable refs from the query data,
 * `top`/`lang` are stable per index) don't change for a row that stays mounted,
 * so memo skips re-running the (span-heavy) cell render. Only the handful of
 * rows entering the window each frame do work — not all ~window rows.
 */
const DiffRow = memo(function DiffRow({
  row,
  prev,
  next,
  hlMap,
  top,
}: {
  row: DiffRow;
  prev?: DiffRow;
  next?: DiffRow;
  hlMap: LineTokens | null;
  top: number;
}) {
  const lc = isLeftChange(row);
  const rc = isRightChange(row);
  return (
    <div
      className="absolute left-0 right-0 grid"
      style={{
        top,
        height: ROW_H,
        // Panes are FIXED 50/50 with the marker between. Long lines don't widen
        // the panes; instead each cell clips (`overflow-hidden`) and its content
        // is panned by the shared `--diff-sx` offset (set on the scroll
        // container), so both panes scroll horizontally together.
        gridTemplateColumns: `1fr ${CENTER_W}px 1fr`,
      }}
    >
      <SideCell
        side={row.left}
        hlMap={hlMap}
        isLeft
        roundTop={lc && !isLeftChange(prev)}
        roundBot={lc && !isLeftChange(next)}
      />
      <CenterMarker row={row} />
      <SideCell
        side={row.right}
        hlMap={hlMap}
        isLeft={false}
        roundTop={rc && !isRightChange(prev)}
        roundBot={rc && !isRightChange(next)}
      />
    </div>
  );
});

export function GitDiffPanel({
  repoPath: repoPathProp,
  file = "",
  staged = false,
  commit = null,
  hidePicker = false,
  only,
  textSources,
  onSelectFile,
  onOpenInEditor,
}: GitDiffPanelProps) {
  const storeRepo = useGitStore.use.repoPath();
  const repoPath = repoPathProp || storeRepo || "";
  const scrollRef = useRef<HTMLDivElement>(null);
  // Jump cursor is internal-only (never rendered), so keep it in a ref — a jump
  // must not force a full-panel re-render.
  const blockCursorRef = useRef(0);
  const lang = getLanguage(file);

  // Collapsible left tree (changed files + commit picker).
  const treePanelRef = usePanelRef();
  const [treeCollapsed, setTreeCollapsed] = useState(false);
  // v4 replaced `autoSaveId`; same storage id, so saved tree widths carry over.
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: TREE_LAYOUT_ID });
  const toggleTree = () =>
    treeCollapsed ? treePanelRef.current?.expand() : treePanelRef.current?.collapse();

  // A supplied text source wins over the repository — see `textSources`.
  const textSource = textSources?.[file];
  const queryKey = diffQueryKey(repoPath, file, staged, commit, textSource);
  const { data, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () =>
      textSource
        ? diffStructuredText(textSource.old, textSource.new, file)
        : gitDiffStructured(repoPath, file, staged, commit),
    // Text-sourced diffs need no repo, so they must not be gated on one.
    enabled: !!file && (!!textSource || !!repoPath),
    staleTime: 10_000,
  });

  useEffect(() => {
    const un = listen("atlas:git-changed", () => void refetch());
    return () => {
      un.then((u) => u());
    };
  }, [refetch]);

  const rows = data?.rows ?? [];
  const changeBlocks = data?.changeBlocks ?? [];

  // Precomputed syntax-highlight tokens for this file (built once off the main
  // thread — see diff-highlight-cache). Rows read it synchronously; until it
  // resolves they render raw text (never blank), then upgrade in one pass when
  // `hlMap` changes identity. Keyed by file + a content signature so an edit
  // (refetch) rebuilds rather than reusing stale tokens.
  const hlKey = data
    ? `${repoPath} ${file} ${staged} ${commit ?? ""} ${data.rows.length}:${data.stats.additions}:${data.stats.deletions}`
    : "";
  const [hlMap, setHlMap] = useState<LineTokens | null>(null);
  useEffect(() => {
    if (!data) {
      setHlMap(null);
      return;
    }
    warmDiffHighlightWorker();
    const cached = getCachedHighlight(hlKey);
    if (cached) {
      setHlMap(cached);
      return;
    }
    setHlMap(null); // paint raw immediately; upgrade when the worker resolves
    const lines: string[] = [];
    for (const r of data.rows) {
      if (r.left) lines.push(r.left.segments.map((s) => s.text).join(""));
      if (r.right) lines.push(r.right.segments.map((s) => s.text).join(""));
    }
    let cancelled = false;
    void ensureDiffHighlight(hlKey, lang, lines).then((m) => {
      if (!cancelled) setHlMap(m);
    });
    return () => {
      cancelled = true;
    };
  }, [hlKey, data, lang]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    // Mounts are cheap now (token lookup, no per-row tokenize), so a wide
    // overscan buys headroom against fast scrolls without blanking.
    overscan: 32,
  });

  const jump = (dir: 1 | -1) => {
    if (changeBlocks.length === 0) return;
    const next = (blockCursorRef.current + dir + changeBlocks.length) % changeBlocks.length;
    blockCursorRef.current = next;
    virtualizer.scrollToIndex(changeBlocks[next], { align: "center" });
  };

  const stats = data?.stats;
  const diffCount = changeBlocks.length;
  const items = virtualizer.getVirtualItems();

  // Longest line (in chars) across each pane — used to clamp the shared
  // horizontal pan (`--diff-sx`). Monospace, so no DOM measurement needed.
  const maxLineLen = useMemo(() => {
    let n = 0;
    for (const r of rows) {
      n = Math.max(n, sideLen(r.left), sideLen(r.right));
    }
    return n;
  }, [rows]);

  // Shared horizontal pan offset (px). Applied via the `--diff-sx` CSS var on
  // the scroll container so every row's content slides together without a
  // React re-render. Horizontal wheel / trackpad (or shift+wheel) drives it;
  // vertical passes through to the native scroller.
  const scrollXRef = useRef(0);
  useEffect(() => {
    // Reset the pan when the file / its content changes.
    scrollXRef.current = 0;
    scrollRef.current?.style.setProperty("--diff-sx", "0px");
  }, [file, staged, rows]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      let dx = 0;
      if (e.shiftKey) dx = e.deltaY || e.deltaX;
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) dx = e.deltaX;
      else return; // vertical intent → let the native scroller handle it
      const paneInner = (el.clientWidth - CENTER_W) / 2 - LINE_NO_W - CODE_PAD;
      const maxSx = Math.max(0, Math.ceil(maxLineLen * monoCharWidth() - paneInner));
      if (maxSx <= 0) return;
      e.preventDefault();
      const next = Math.min(maxSx, Math.max(0, scrollXRef.current + dx));
      if (next !== scrollXRef.current) {
        scrollXRef.current = next;
        el.style.setProperty("--diff-sx", `${next}px`);
      }
    };
    // Non-passive so `preventDefault` actually suppresses the browser's
    // horizontal overscroll / back-nav gesture.
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [maxLineLen]);

  return (
    <Group
      id={TREE_LAYOUT_ID}
      orientation="horizontal"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className="h-full bg-[var(--bg-primary)]"
    >
      {/* Left: resizable + collapsible tree of changed files (+ commit picker) */}
      {/* Sizes are percentages: v4 reads bare numbers as PIXELS and unit-less
          strings as percentages. `onCollapse`/`onExpand` are gone; with a
          `collapsedSize` of 0 the collapsed state is exactly "zero width", so
          `onResize` carries the same signal. */}
      <Panel
        id="git-diff-tree-files"
        panelRef={treePanelRef}
        collapsible
        collapsedSize="0"
        defaultSize="22"
        minSize="12"
        maxSize="45"
        className="min-w-0"
        onResize={(size) => setTreeCollapsed(size.inPixels === 0)}
      >
        <ChangedFilesTree
          repoPath={repoPath}
          staged={staged}
          currentFile={file}
          commit={commit}
          hidePicker={hidePicker}
          only={only}
          onSelect={onSelectFile}
        />
      </Panel>
      <Separator className="w-px bg-border-default hover:bg-accent data-[separator=active]:bg-accent transition-colors cursor-col-resize" />

      {/* Main column: toolbar + diff body */}
      <Panel id="git-diff-tree-diff" className="min-w-0">
        <div className="flex h-full min-w-0 flex-col">
          {/* Toolbar */}
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3">
            <button
              onClick={toggleTree}
              className="-ml-1 rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
              title={treeCollapsed ? "Show changed files" : "Hide changed files"}
            >
              {treeCollapsed ? <PanelLeftOpen size={12} /> : <PanelLeftClose size={12} />}
            </button>
            <FileCode2 size={12} className="shrink-0 text-[var(--text-tertiary)]" />
            <span className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
              {file || "Git Diff"}
            </span>
            {staged && (
              <span className="shrink-0 rounded bg-[var(--bg-elevated)] px-1.5 py-px text-[9px] uppercase tracking-wide text-[var(--text-tertiary)]">
                staged
              </span>
            )}
            {stats && (
              <span className="shrink-0 font-mono text-[10px]">
                <span className="text-[var(--status-success)]">+{stats.additions}</span>{" "}
                <span className="text-[var(--status-error)]">-{stats.deletions}</span>
              </span>
            )}
            {!!file && (
              <div className="ml-auto flex items-center gap-0.5">
                <span className="mr-1 font-mono text-[10px] text-[var(--text-tertiary)] tabular-nums">
                  {diffCount} diff{diffCount !== 1 ? "s" : ""}
                </span>
                <button
                  onClick={() => jump(-1)}
                  disabled={diffCount === 0}
                  className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30 cursor-pointer"
                  title="Previous change"
                >
                  <ChevronUp size={12} />
                </button>
                <button
                  onClick={() => jump(1)}
                  disabled={diffCount === 0}
                  className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30 cursor-pointer"
                  title="Next change"
                >
                  <ChevronDown size={12} />
                </button>
                <button
                  onClick={() => void refetch()}
                  className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
                  title="Refresh"
                >
                  <RefreshCw size={11} />
                </button>
                <button
                  onClick={() => {
                    void openFile(`${repoPath}/${file}`);
                    onOpenInEditor?.();
                  }}
                  className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
                  title="Open in editor"
                >
                  <ExternalLink size={11} />
                </button>
              </div>
            )}
          </div>

          {/* Body */}
          {!file ? (
            <div className="flex flex-1 items-center justify-center px-3 text-center text-[11px] text-[var(--text-tertiary)]">
              Pick a file from the left to view its diff — or choose a commit to browse.
            </div>
          ) : isLoading ? (
            <div className="px-3 py-8 text-center text-[11px] text-[var(--text-tertiary)]">
              Loading diff…
            </div>
          ) : data?.isBinary ? (
            <div className="px-3 py-8 text-center text-[11px] text-[var(--text-tertiary)]">
              Binary file — no text diff to show.
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-[11px] text-[var(--text-tertiary)]">
              No changes.
            </div>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto hide-scrollbar">
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {items.map((vr) => (
                    <DiffRow
                      key={vr.index}
                      row={rows[vr.index]}
                      prev={rows[vr.index - 1]}
                      next={rows[vr.index + 1]}
                      hlMap={hlMap}
                      top={vr.start}
                    />
                  ))}
                </div>
              </div>
              {/* Right: change minimap synced to the diff scroll position */}
              <DiffMinimap rows={rows} scrollRef={scrollRef} />
            </div>
          )}
        </div>
      </Panel>
    </Group>
  );
}
