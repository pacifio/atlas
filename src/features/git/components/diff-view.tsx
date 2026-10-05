import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Popover } from "@base-ui/react/popover";
import {
  ExternalLink,
  ChevronRight,
  Search,
  ArrowDownWideNarrow,
  Code,
  FoldVertical,
  UnfoldVertical,
  RefreshCw,
  MoreHorizontal,
  GitCompare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { HintGroup, HintItem } from "@/ui/hint-group";
import { parseDiff, buildRows, type DiffFile, type DiffHunk } from "../lib/diff";
import { highlightDiffLine } from "../lib/diff-highlight";

type SortMode = "default" | "most-changes";

/** `comment`: start a comment on the hunk's (or the selected) lines — a Shared Thread's diff (ATL-416). */
export type HunkAction = "stage" | "unstage" | "discard" | "comment";

/**
 * Virtualized unified-diff renderer. Takes raw `git diff`/`git show` text and
 * draws per-file collapsible cards with red/green hunks. Shared by the
 * source-control manager's Changes view and the History commit view.
 *
 * With `filters`, it shows the changed-file filter header (search / sort /
 * language) + stats, matching the old Changes panel.
 */
export function DiffView({
  diff,
  onOpenFile,
  onOpenDiff,
  onRefresh,
  filters = false,
  emptyLabel = "No changes",
  className,
  hunkActions,
  onHunkAction,
}: {
  diff: string;
  onOpenFile?: (path: string) => void;
  /** Open this file in the dedicated side-by-side diff tab. */
  onOpenDiff?: (path: string) => void;
  onRefresh?: () => void;
  filters?: boolean;
  emptyLabel?: string;
  className?: string;
  /** Which hunk-level buttons to show on hunk headers (none = read-only). */
  hunkActions?: HunkAction[];
  /** Invoked with the DISPLAYED hunk (+ selected line indices, if any). */
  onHunkAction?: (action: HunkAction, file: string, hunk: DiffHunk, selected?: number[]) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [langFilter, setLangFilter] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Line selection for partial staging, keyed `${fileIndex}:${hunkIndex}`.
  // Reset whenever the diff text changes — indices would no longer line up.
  const [lineSel, setLineSel] = useState<Map<string, Set<number>>>(new Map());
  const selectable = !!onHunkAction && (hunkActions?.length ?? 0) > 0;
  useEffect(() => {
    setLineSel(new Map());
  }, [diff]);

  const toggleLine = (fileIndex: number, hunkIndex: number, lineIndex: number) => {
    setLineSel((prev) => {
      const key = `${fileIndex}:${hunkIndex}`;
      const next = new Map(prev);
      const set = new Set(next.get(key) ?? []);
      if (set.has(lineIndex)) set.delete(lineIndex);
      else set.add(lineIndex);
      if (set.size === 0) next.delete(key);
      else next.set(key, set);
      return next;
    });
  };

  const fireHunkAction = (
    action: HunkAction,
    file: string,
    hunk: DiffHunk,
    fileIndex: number,
    hunkIndex: number,
  ) => {
    const sel = lineSel.get(`${fileIndex}:${hunkIndex}`);
    onHunkAction?.(
      action,
      file,
      hunk,
      sel && sel.size > 0 ? [...sel].sort((a, b) => a - b) : undefined,
    );
    setLineSel(new Map());
  };

  const allFiles = useMemo(() => parseDiff(diff), [diff]);

  const languages = useMemo(() => {
    return Array.from(new Set(allFiles.map((f) => f.language))).sort();
  }, [allFiles]);

  const files = useMemo(() => {
    if (!filters) return allFiles;
    let result = allFiles;
    const q = query.trim().toLowerCase();
    if (q) result = result.filter((f) => f.path.toLowerCase().includes(q));
    if (langFilter) result = result.filter((f) => f.language === langFilter);
    if (sortMode === "most-changes") {
      result = [...result].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
    }
    return result;
  }, [allFiles, filters, query, langFilter, sortMode]);

  const rows = useMemo(() => buildRows(files, collapsed), [files, collapsed]);
  const totalAdd = useMemo(() => files.reduce((s, f) => s + f.additions, 0), [files]);
  const totalDel = useMemo(() => files.reduce((s, f) => s + f.deletions, 0), [files]);
  const anyExpanded = files.some((f) => !collapsed.has(f.path));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const k = rows[i].kind;
      if (k === "file-header") return 42;
      if (k === "file-footer") return 8;
      if (k === "hunk-header") return 22;
      return 20;
    },
    overscan: 30,
  });

  const toggleFile = (path: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const header = filters ? (
    <HintGroup>
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center justify-between px-3 pt-2">
          <span className="text-2xs font-mono text-muted-foreground">
            {files.length} file{files.length !== 1 ? "s" : ""}{" "}
            <span className="text-success">+{totalAdd}</span>{" "}
            <span className="text-error">-{totalDel}</span>
          </span>
          <div className="flex items-center gap-0.5">
            <HintItem label={anyExpanded ? "Collapse all" : "Expand all"}>
              <button
                onClick={() =>
                  setCollapsed(anyExpanded ? new Set(files.map((f) => f.path)) : new Set())
                }
                className="p-1 rounded hover:bg-element-hover text-muted-foreground cursor-pointer"
              >
                {anyExpanded ? <FoldVertical size={10} /> : <UnfoldVertical size={10} />}
              </button>
            </HintItem>
            {onRefresh && (
              <HintItem label="Refresh diff">
                <button
                  onClick={onRefresh}
                  className="p-1 rounded hover:bg-element-hover text-muted-foreground cursor-pointer"
                >
                  <RefreshCw size={10} />
                </button>
              </HintItem>
            )}
            <FileListPopover files={files} onOpen={onOpenFile} />
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-3 py-1.5">
          <div className="flex-1 flex items-center gap-1.5 h-6 rounded border border-border bg-card px-2">
            <Search size={10} className="text-muted-foreground shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter files…"
              className="flex-1 bg-transparent outline-none text-2xs text-foreground placeholder:text-muted-foreground min-w-0"
            />
          </div>
          <HintItem label="Sort by most changes">
            <button
              onClick={() => setSortMode(sortMode === "most-changes" ? "default" : "most-changes")}
              className={cn(
                "p-1 rounded transition-colors cursor-pointer",
                sortMode === "most-changes"
                  ? "text-primary bg-element-selected"
                  : "text-muted-foreground hover:bg-element-hover",
              )}
            >
              <ArrowDownWideNarrow size={11} />
            </button>
          </HintItem>
          <LangFilterPopover languages={languages} active={langFilter} onSelect={setLangFilter} />
        </div>
      </div>
    </HintGroup>
  ) : null;

  return (
    // `min-w-0` is load-bearing: the virtualized rows below use `width:
    // max-content` so long lines can scroll horizontally. Without it, that
    // intrinsic width propagates up the flex chain and the whole panel grows
    // past its bounds (the diff bg bleeds outside) instead of scrolling.
    <div className={cn("flex flex-col min-h-0 min-w-0", className)}>
      {header}
      {files.length === 0 ? (
        <div className="px-3 py-8 text-center text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 min-w-0 overflow-auto hide-scrollbar px-3 py-2"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vr) => {
              const row = rows[vr.index];
              // No fixed `height` — rows are MEASURED (`measureElement` below),
              // so a file-header/content line that renders taller than its
              // estimate never overlaps the next row (the source-control diff
              // overlap bug). `estimateSize` is just the initial guess.
              const base = {
                position: "absolute" as const,
                top: 0,
                transform: `translateY(${vr.start}px)`,
                width: "100%",
              };

              if (row.kind === "file-header") {
                const file = row.file;
                const isCollapsed = collapsed.has(file.path);
                return (
                  <HintGroup key={vr.index}>
                    <div
                      data-index={vr.index}
                      ref={virtualizer.measureElement}
                      style={base}
                      className="flex items-center gap-1.5 px-2 py-1.5 rounded-t-md border border-border bg-card hover:bg-accent cursor-pointer group"
                      onClick={() => toggleFile(file.path)}
                    >
                      <ChevronRight
                        size={11}
                        className={cn(
                          "shrink-0 text-muted-foreground transition-transform",
                          !isCollapsed && "rotate-90",
                        )}
                      />
                      <span className="text-xs text-secondary-foreground font-mono truncate flex-1 select-text">
                        {file.path}
                      </span>
                      {onOpenDiff && (
                        <HintItem label="Open in diff view">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenDiff(file.path);
                            }}
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 text-muted-foreground hover:text-foreground"
                          >
                            <GitCompare size={10} />
                          </button>
                        </HintItem>
                      )}
                      {onOpenFile && (
                        <HintItem label="Open in code editor">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenFile(file.path);
                            }}
                            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink size={9} />
                          </button>
                        </HintItem>
                      )}
                      <span className="text-3xs font-mono shrink-0">
                        <span className="text-success">+{file.additions}</span>{" "}
                        <span className="text-error">-{file.deletions}</span>
                      </span>
                    </div>
                  </HintGroup>
                );
              }

              if (row.kind === "hunk-header") {
                const sel = lineSel.get(`${row.fileIndex}:${row.hunkIndex}`);
                const nSel = sel?.size ?? 0;
                const label = (verb: string) =>
                  nSel > 0 ? `${verb} ${nSel} line${nSel === 1 ? "" : "s"}` : `${verb} hunk`;
                return (
                  <div
                    key={vr.index}
                    data-index={vr.index}
                    ref={virtualizer.measureElement}
                    style={{ ...base, backgroundColor: "var(--atlas-diff-context-background)" }}
                    className="group/hunk flex items-center gap-2 px-2 h-[22px] border-x border-border text-2xs font-mono text-muted-foreground"
                  >
                    <span className="truncate flex-1 text-[var(--atlas-status-info-foreground)]/70 select-text">
                      {row.hunk.header}
                    </span>
                    {selectable && hunkActions && (
                      <span className="flex items-center gap-1 opacity-0 group-hover/hunk:opacity-100 shrink-0">
                        {hunkActions.includes("stage") && (
                          <button
                            onClick={() =>
                              fireHunkAction(
                                "stage",
                                row.file.path,
                                row.hunk,
                                row.fileIndex,
                                row.hunkIndex,
                              )
                            }
                            className="px-1.5 h-[16px] rounded border border-border text-3xs text-secondary-foreground hover:text-foreground hover:bg-element-hover"
                          >
                            {label("Stage")}
                          </button>
                        )}
                        {hunkActions.includes("unstage") && (
                          <button
                            onClick={() =>
                              fireHunkAction(
                                "unstage",
                                row.file.path,
                                row.hunk,
                                row.fileIndex,
                                row.hunkIndex,
                              )
                            }
                            className="px-1.5 h-[16px] rounded border border-border text-3xs text-secondary-foreground hover:text-foreground hover:bg-element-hover"
                          >
                            {label("Unstage")}
                          </button>
                        )}
                        {hunkActions.includes("comment") && (
                          <button
                            onClick={() =>
                              fireHunkAction(
                                "comment",
                                row.file.path,
                                row.hunk,
                                row.fileIndex,
                                row.hunkIndex,
                              )
                            }
                            className="px-1.5 h-[16px] rounded border border-border text-3xs text-secondary-foreground hover:text-foreground hover:bg-element-hover"
                          >
                            {label("Comment on")}
                          </button>
                        )}
                        {hunkActions.includes("discard") && (
                          <button
                            onClick={() =>
                              fireHunkAction(
                                "discard",
                                row.file.path,
                                row.hunk,
                                row.fileIndex,
                                row.hunkIndex,
                              )
                            }
                            className="px-1.5 h-[16px] rounded border border-border text-3xs text-secondary-foreground hover:text-[var(--atlas-status-error-foreground)] hover:bg-element-hover"
                          >
                            {label("Discard")}
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                );
              }

              if (row.kind === "file-footer") {
                return (
                  <div
                    key={vr.index}
                    data-index={vr.index}
                    ref={virtualizer.measureElement}
                    // Empty spacer — keep an explicit height so it measures 8px.
                    style={{
                      ...base,
                      height: 8,
                      backgroundColor: "var(--atlas-diff-context-background)",
                    }}
                    className="border-x border-b border-border rounded-b-md"
                  />
                );
              }

              const line = row.line;
              const isChange = line.type !== "context";
              const isSelected =
                isChange &&
                (lineSel.get(`${row.fileIndex}:${row.hunkIndex}`)?.has(row.lineIndex) ?? false);
              return (
                <div
                  key={vr.index}
                  data-index={vr.index}
                  ref={virtualizer.measureElement}
                  onClick={
                    selectable && isChange
                      ? () => toggleLine(row.fileIndex, row.hunkIndex, row.lineIndex)
                      : undefined
                  }
                  title={selectable && isChange ? "Click to select for partial staging" : undefined}
                  // Clip long lines to the viewport width (no horizontal scroll,
                  // no row overflow/overlap). Users open the full diff view to
                  // read a truncated line in its entirety.
                  style={{
                    ...base,
                    width: "100%",
                    overflow: "hidden",
                    cursor: selectable && isChange ? "pointer" : undefined,
                    outline: isSelected ? "1px solid var(--primary)" : undefined,
                    outlineOffset: isSelected ? -1 : undefined,
                    backgroundColor:
                      line.type === "add"
                        ? "var(--atlas-diff-added-background)"
                        : line.type === "remove"
                          ? "var(--atlas-diff-removed-background)"
                          : "var(--atlas-diff-context-background)",
                  }}
                  className="flex text-xs font-mono leading-[20px] select-text border-x border-border"
                >
                  <span
                    className={cn(
                      "w-[3px] shrink-0",
                      line.type === "add" && "bg-success",
                      line.type === "remove" && "bg-error",
                    )}
                  />
                  <span className="w-[36px] shrink-0 text-right pr-2 text-2xs text-muted-foreground select-none">
                    {line.oldLine ?? ""}
                  </span>
                  <span className="w-[36px] shrink-0 text-right pr-2 text-2xs text-muted-foreground select-none">
                    {line.newLine ?? ""}
                  </span>
                  <DiffCode
                    content={line.content}
                    language={files[row.fileIndex]?.language ?? ""}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Renders a diff line's code text with cheap, synchronous syntax highlighting
 *  (lowlight → `.diff-syntax` themed token spans). Falls back to plain text for
 *  unsupported languages / empty lines so it can never break the row. */
function DiffCode({ content, language }: { content: string; language: string }) {
  const tokens = highlightDiffLine(language, content);
  if (!tokens) {
    return (
      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-pre pr-3 text-secondary-foreground">
        {content}
      </span>
    );
  }
  return (
    <span className="diff-syntax flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-pre pr-3 text-secondary-foreground">
      {tokens.map((t, i) => (
        <span key={i} className={t.cls ?? undefined}>
          {t.text}
        </span>
      ))}
    </span>
  );
}

function LangFilterPopover({
  languages,
  active,
  onSelect,
}: {
  languages: string[];
  active: string | null;
  onSelect: (lang: string | null) => void;
}) {
  return (
    <Popover.Root>
      <HintItem label="Filter by language">
        <Popover.Trigger
          render={
            <button
              className={cn(
                "p-1 rounded transition-colors cursor-pointer",
                active
                  ? "text-primary bg-element-selected"
                  : "text-muted-foreground hover:bg-element-hover",
              )}
            >
              <Code size={11} />
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="w-[140px] rounded-lg border border-border bg-[var(--card)] shadow-md py-1">
            <button
              onClick={() => onSelect(null)}
              className={cn(
                "w-full text-left px-3 h-control-md text-2xs hover:bg-element-hover cursor-default outline-none",
                !active ? "text-primary" : "text-secondary-foreground",
              )}
            >
              All languages
            </button>
            {languages.map((lang) => (
              <button
                key={lang}
                onClick={() => onSelect(active === lang ? null : lang)}
                className={cn(
                  "w-full text-left px-3 h-control-md text-2xs hover:bg-element-hover cursor-default outline-none",
                  active === lang ? "text-primary" : "text-secondary-foreground",
                )}
              >
                {lang}
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function FileListPopover({
  files,
  onOpen,
}: {
  files: DiffFile[];
  onOpen?: (path: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = files.filter((f) => f.path.toLowerCase().includes(search.toLowerCase()));
  return (
    <Popover.Root onOpenChange={() => setSearch("")}>
      <HintItem label="All changed files">
        <Popover.Trigger
          render={
            <button className="p-1 rounded hover:bg-element-hover text-muted-foreground cursor-pointer">
              <MoreHorizontal size={10} />
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={4}>
          <Popover.Popup className="w-[280px] max-h-[300px] rounded-lg border border-border bg-[var(--card)] shadow-md flex flex-col">
            <div className="flex items-center gap-1.5 px-2 h-[30px] border-b border-border shrink-0">
              <Search size={10} className="text-muted-foreground shrink-0" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search files…"
                className="flex-1 bg-transparent outline-none text-2xs text-foreground placeholder:text-muted-foreground"
                autoFocus
                onKeyDown={(e) => {
                  // Keep keys from the popup's typeahead and arrow nav, but let Escape
                  // bubble to the dismiss handler so it still closes the popup.
                  if (e.key !== "Escape") e.stopPropagation();
                }}
              />
            </div>
            <div className="overflow-y-auto py-1 hide-scrollbar">
              {filtered.map((file) => (
                <button
                  key={file.path}
                  onClick={() => onOpen?.(file.path)}
                  className="w-full flex items-center gap-2 px-3 h-control-md text-2xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-default outline-none font-mono"
                >
                  <span className="truncate flex-1 text-left">{file.path}</span>
                  <span className="shrink-0">
                    <span className="text-success">+{file.additions}</span>{" "}
                    <span className="text-error">-{file.deletions}</span>
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-2xs text-muted-foreground text-center">
                  No files found
                </div>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
