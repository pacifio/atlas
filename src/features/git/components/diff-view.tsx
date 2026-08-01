import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as Popover from "@radix-ui/react-popover";
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
import { parseDiff, buildRows, type DiffFile } from "../lib/diff";
import { highlightDiffLine } from "../lib/diff-highlight";

type SortMode = "default" | "most-changes";

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
}: {
  diff: string;
  onOpenFile?: (path: string) => void;
  /** Open this file in the dedicated side-by-side diff tab. */
  onOpenDiff?: (path: string) => void;
  onRefresh?: () => void;
  filters?: boolean;
  emptyLabel?: string;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [langFilter, setLangFilter] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
      result = [...result].sort(
        (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
      );
    }
    return result;
  }, [allFiles, filters, query, langFilter, sortMode]);

  const rows = useMemo(() => buildRows(files, collapsed), [files, collapsed]);
  const totalAdd = useMemo(
    () => files.reduce((s, f) => s + f.additions, 0),
    [files],
  );
  const totalDel = useMemo(
    () => files.reduce((s, f) => s + f.deletions, 0),
    [files],
  );
  const anyExpanded = files.some((f) => !collapsed.has(f.path));

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const k = rows[i].kind;
      if (k === "file-header") return 42;
      if (k === "file-footer") return 8;
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
    <div className="shrink-0 border-b border-border-default">
      <div className="flex items-center justify-between px-3 pt-2">
        <span className="text-[10px] font-mono text-text-tertiary">
          {files.length} file{files.length !== 1 ? "s" : ""}{" "}
          <span className="text-success">+{totalAdd}</span>{" "}
          <span className="text-error">-{totalDel}</span>
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() =>
              setCollapsed(
                anyExpanded ? new Set(files.map((f) => f.path)) : new Set(),
              )
            }
            className="p-1 rounded hover:bg-bg-hover text-text-tertiary cursor-pointer"
            title={anyExpanded ? "Collapse all" : "Expand all"}
          >
            {anyExpanded ? (
              <FoldVertical size={10} />
            ) : (
              <UnfoldVertical size={10} />
            )}
          </button>
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="p-1 rounded hover:bg-bg-hover text-text-tertiary cursor-pointer"
              title="Refresh diff"
            >
              <RefreshCw size={10} />
            </button>
          )}
          <FileListPopover files={files} onOpen={onOpenFile} />
        </div>
      </div>
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <div className="flex-1 flex items-center gap-1.5 h-6 rounded border border-border-default bg-bg-secondary px-2">
          <Search size={10} className="text-text-tertiary shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files…"
            className="flex-1 bg-transparent outline-none text-[10px] text-text-primary placeholder:text-text-tertiary min-w-0"
          />
        </div>
        <button
          onClick={() =>
            setSortMode(
              sortMode === "most-changes" ? "default" : "most-changes",
            )
          }
          className={cn(
            "p-1 rounded transition-colors cursor-pointer",
            sortMode === "most-changes"
              ? "text-accent bg-bg-selected"
              : "text-text-tertiary hover:bg-bg-hover",
          )}
          title="Sort by most changes"
        >
          <ArrowDownWideNarrow size={11} />
        </button>
        <LangFilterPopover
          languages={languages}
          active={langFilter}
          onSelect={setLangFilter}
        />
      </div>
    </div>
  ) : null;

  return (
    // `min-w-0` is load-bearing: the virtualized rows below use `width:
    // max-content` so long lines can scroll horizontally. Without it, that
    // intrinsic width propagates up the flex chain and the whole panel grows
    // past its bounds (the diff bg bleeds outside) instead of scrolling.
    <div className={cn("flex flex-col min-h-0 min-w-0", className)}>
      {header}
      {files.length === 0 ? (
        <div className="px-3 py-8 text-center text-[11px] text-text-tertiary">
          {emptyLabel}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 min-w-0 overflow-auto hide-scrollbar px-3 py-2"
        >
          <div
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
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
                  <div
                    key={vr.index}
                    data-index={vr.index}
                    ref={virtualizer.measureElement}
                    style={base}
                    className="flex items-center gap-1.5 px-2 py-1.5 rounded-t-md border border-border-default bg-[#0F0F0F] hover:bg-[#141414] cursor-pointer group"
                    onClick={() => toggleFile(file.path)}
                  >
                    <ChevronRight
                      size={11}
                      className={cn(
                        "shrink-0 text-text-tertiary transition-transform",
                        !isCollapsed && "rotate-90",
                      )}
                    />
                    <span className="text-[11px] text-text-secondary font-mono truncate flex-1 select-text">
                      {file.path}
                    </span>
                    {onOpenDiff && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDiff(file.path);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-text-primary"
                        title="Open in diff view"
                      >
                        <GitCompare size={10} />
                      </button>
                    )}
                    {onOpenFile && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenFile(file.path);
                        }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-text-primary"
                        title="Open in code editor"
                      >
                        <ExternalLink size={9} />
                      </button>
                    )}
                    <span className="text-[9px] font-mono shrink-0">
                      <span className="text-success">+{file.additions}</span>{" "}
                      <span className="text-error">-{file.deletions}</span>
                    </span>
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
                      backgroundColor: "var(--diff-context-bg, #0a0a0a)",
                    }}
                    className="border-x border-b border-border-default rounded-b-md"
                  />
                );
              }

              const line = row.line;
              return (
                <div
                  key={vr.index}
                  data-index={vr.index}
                  ref={virtualizer.measureElement}
                  // Clip long lines to the viewport width (no horizontal scroll,
                  // no row overflow/overlap). Users open the full diff view to
                  // read a truncated line in its entirety.
                  style={{
                    ...base,
                    width: "100%",
                    overflow: "hidden",
                    backgroundColor:
                      line.type === "add"
                        ? "var(--diff-add-line-bg, #0d2211)"
                        : line.type === "remove"
                          ? "var(--diff-remove-line-bg, #220d0d)"
                          : "var(--diff-context-bg, #0a0a0a)",
                  }}
                  className="flex text-[11px] font-mono leading-[20px] select-text border-x border-border-default"
                >
                  <span
                    className={cn(
                      "w-[3px] shrink-0",
                      line.type === "add" && "bg-success",
                      line.type === "remove" && "bg-error",
                    )}
                  />
                  <span className="w-[36px] shrink-0 text-right pr-2 text-[10px] text-text-tertiary select-none">
                    {line.oldLine ?? ""}
                  </span>
                  <span className="w-[36px] shrink-0 text-right pr-2 text-[10px] text-text-tertiary select-none">
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
function DiffCode({
  content,
  language,
}: {
  content: string;
  language: string;
}) {
  const tokens = highlightDiffLine(language, content);
  if (!tokens) {
    return (
      <span className="flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-pre pr-3 text-text-secondary">
        {content}
      </span>
    );
  }
  return (
    <span className="diff-syntax flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-pre pr-3 text-text-secondary">
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
      <Popover.Trigger asChild>
        <button
          className={cn(
            "p-1 rounded transition-colors cursor-pointer",
            active
              ? "text-accent bg-bg-selected"
              : "text-text-tertiary hover:bg-bg-hover",
          )}
          title="Filter by language"
        >
          <Code size={11} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="w-[140px] rounded-lg border border-border-default bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)] py-1"
          style={{ zIndex: 99999 }}
        >
          <button
            onClick={() => onSelect(null)}
            className={cn(
              "w-full text-left px-3 h-[26px] text-[10px] hover:bg-bg-hover cursor-default outline-none",
              !active ? "text-accent" : "text-text-secondary",
            )}
          >
            All languages
          </button>
          {languages.map((lang) => (
            <button
              key={lang}
              onClick={() => onSelect(active === lang ? null : lang)}
              className={cn(
                "w-full text-left px-3 h-[26px] text-[10px] hover:bg-bg-hover cursor-default outline-none",
                active === lang ? "text-accent" : "text-text-secondary",
              )}
            >
              {lang}
            </button>
          ))}
        </Popover.Content>
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
  const filtered = files.filter((f) =>
    f.path.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <Popover.Root onOpenChange={() => setSearch("")}>
      <Popover.Trigger asChild>
        <button
          className="p-1 rounded hover:bg-bg-hover text-text-tertiary cursor-pointer"
          title="All changed files"
        >
          <MoreHorizontal size={10} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="w-[280px] max-h-[300px] rounded-lg border border-border-default bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)] flex flex-col"
          style={{ zIndex: 99999 }}
        >
          <div className="flex items-center gap-1.5 px-2 h-[30px] border-b border-border-default shrink-0">
            <Search size={10} className="text-text-tertiary shrink-0" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files…"
              className="flex-1 bg-transparent outline-none text-[10px] text-text-primary placeholder:text-text-tertiary"
              autoFocus
              onKeyDown={(e) => e.stopPropagation()}
            />
          </div>
          <div className="overflow-y-auto py-1 hide-scrollbar">
            {filtered.map((file) => (
              <button
                key={file.path}
                onClick={() => onOpen?.(file.path)}
                className="w-full flex items-center gap-2 px-3 h-[26px] text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-default outline-none font-mono"
              >
                <span className="truncate flex-1 text-left">{file.path}</span>
                <span className="shrink-0">
                  <span className="text-success">+{file.additions}</span>{" "}
                  <span className="text-error">-{file.deletions}</span>
                </span>
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[10px] text-text-tertiary text-center">
                No files found
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
