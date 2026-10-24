import { Fragment, memo, useEffect, useRef } from "react";
import { AlertCircle, ChevronRight, GitCompare, Link2, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { FileIcon } from "@/features/icon-theme/components/file-icon";
import { nameOf, type TreeRowData } from "../lib/project-tree-model";
import { entryNameError } from "../lib/project-file-ops";
import { INDENT_PER_LEVEL, ROW_HEIGHT } from "../lib/tree-constants";

/**
 * One row of the project file tree.
 *
 * Every prop is a primitive or a shared, stable object, and every handler is
 * delegated to the tree's scroller through `data-*` attributes, so `memo`
 * holds: opening a folder re-renders that folder's row and the rows that came
 * into view, not the hundred around them. The row carries its absolute path
 * in `data-tree-path` for the same reason the explorer's rows do: the drag
 * and drop hooks hit-test the DOM, not React.
 */
export interface ProjectTreeRowProps {
  row: TreeRowData;
  /** Absolute; what the DOM, the drag hooks and the icon theme see. */
  absPath: string;
  /** `aria-activedescendant` target. */
  domId: string;
  start: number;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  selected: boolean;
  focused: boolean;
  /** The file in the active editor tab. */
  active: boolean;
  cut: boolean;
  dropTarget: boolean;
  /** Absolute: the outer folder of a compacted row something is dragged
   *  over (its name is a drop target of its own). */
  dropSegment: string | null;
  dragging: boolean;
  /** Status colour for a changed file, or the strongest one below a
   *  collapsed folder. */
  gitColor: string | null;
  additions: number | null;
  deletions: number | null;
  /** A changed file: offer its diff. */
  changed: boolean;
  hideArrows: boolean;
  renaming: boolean;
  onRenameCommit: (path: string, name: string) => void;
  onRenameCancel: () => void;
}

export const ProjectTreeRow = memo(function ProjectTreeRow({
  row,
  absPath,
  domId,
  start,
  expanded,
  loading,
  error,
  selected,
  focused,
  active,
  cut,
  dropTarget,
  dropSegment,
  dragging,
  gitColor,
  additions,
  deletions,
  changed,
  hideArrows,
  renaming,
  onRenameCommit,
  onRenameCancel,
}: ProjectTreeRowProps) {
  const isDir = row.kind === "directory";
  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={selected}
      data-tree-path={absPath}
      data-tree-is-dir={isDir}
      data-rel-path={row.path}
      title={error ?? absPath}
      className={cn(
        "group absolute top-0 right-1 left-1 flex items-center gap-1.5 rounded-md select-none",
        "cursor-pointer transition-colors duration-fast",
        selected
          ? "bg-element-selected text-foreground"
          : active
            ? "bg-card text-foreground"
            : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
        // Keyboard only: a mouse user sees the fill; the ring marks where
        // arrow keys move from.
        focused &&
          "group-focus-visible/tree:ring-1 group-focus-visible/tree:ring-border-strong group-focus-visible/tree:ring-inset",
        dropTarget &&
          "bg-[var(--atlas-primary-muted)] text-foreground ring-1 ring-primary/40 ring-inset",
        dragging && "opacity-40",
        cut && "opacity-50",
      )}
      style={{
        height: ROW_HEIGHT,
        transform: `translateY(${start}px)`,
        paddingLeft: 2 + row.depth * INDENT_PER_LEVEL,
        paddingRight: 6,
      }}
    >
      {isDir && !hideArrows ? (
        <ChevronRight
          size={12}
          strokeWidth={2}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-fast",
            expanded && "rotate-90",
          )}
        />
      ) : (
        <span className="w-3 shrink-0" aria-hidden />
      )}
      {/* An ignored entry keeps its icon's colour, at half strength. */}
      <span className={cn("flex shrink-0", row.ignored && "opacity-50")}>
        <FileIcon
          path={absPath}
          kind={isDir ? (expanded ? "folderExpanded" : "folder") : "file"}
          size={13}
        />
      </span>
      {renaming ? (
        <RenameInput
          initial={row.name}
          onCommit={(name) => onRenameCommit(row.path, name)}
          onCancel={onRenameCancel}
        />
      ) : (
        // One line, cut with an ellipsis at the end; the full path is the
        // row's tooltip.
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-sans text-sm",
            isDir && "text-foreground",
            row.ignored && "text-disabled",
            row.match && "font-semibold",
          )}
          style={!isDir && gitColor && !row.ignored ? { color: gitColor } : undefined}
        >
          {row.chain ? (
            <ChainLabel
              chain={row.chain}
              base={absPath.slice(0, absPath.length - row.path.length)}
              dropSegment={dropSegment}
            />
          ) : (
            row.name
          )}
        </span>
      )}
      {!renaming && row.kind === "symlink" && (
        <Link2 aria-label="Symbolic link" className="size-3 shrink-0 text-muted-foreground" />
      )}
      {!renaming && (
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {loading && (
            <LoaderCircle
              size={11}
              className="animate-spin text-muted-foreground"
              aria-label="Loading"
            />
          )}
          {error && <AlertCircle size={11} className="text-error" aria-label={error} />}
          {changed && (
            <button
              type="button"
              tabIndex={-1}
              data-tree-action="diff"
              aria-label={`Show changes in ${row.name}`}
              title="Show changes"
              className="hidden size-4 items-center justify-center rounded text-muted-foreground group-hover:flex hover:bg-element-hover hover:text-foreground"
            >
              <GitCompare size={11} />
            </button>
          )}
          {additions !== null && additions > 0 && (
            <span className="font-mono text-2xs text-[var(--atlas-diff-added-text)] tabular-nums">
              +{additions}
            </span>
          )}
          {deletions !== null && deletions > 0 && (
            <span className="font-mono text-2xs text-[var(--atlas-diff-removed-text)] tabular-nums">
              −{deletions}
            </span>
          )}
          {gitColor && (
            <span
              className={cn("grid size-3 place-items-center", isDir && "opacity-50")}
              aria-label={isDir ? "Contains changed files" : "Changed"}
            >
              <span className="size-1.5 rounded-full" style={{ background: gitColor }} />
            </span>
          )}
        </span>
      )}
    </div>
  );
});

/**
 * A compacted folder chain's name: each folder's, between quiet slashes.
 * Clicks, menus and rename act on the row, which is the innermost folder;
 * each outer name is a drop target for its own folder.
 */
function ChainLabel({
  chain,
  base,
  dropSegment,
}: {
  chain: readonly string[];
  /** The root with its trailing slash: `base + link` is a link's path. */
  base: string;
  dropSegment: string | null;
}) {
  return chain.map((path, i) => {
    const abs = base + path;
    const outer = i < chain.length - 1;
    return (
      <Fragment key={path}>
        {i > 0 && <span className="px-1 text-muted-foreground">/</span>}
        <span
          data-tree-drop-path={outer ? abs : undefined}
          className={cn(dropSegment === abs && "rounded-sm bg-[var(--atlas-primary-muted)]")}
        >
          {nameOf(path)}
        </span>
      </Fragment>
    );
  });
}

/**
 * The inline name editor for rename and for a new entry. Pre-selects the stem
 * so typing replaces the name and keeps the extension, as Finder does; the
 * double frame lets a closing context menu hand focus back first.
 */
export function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        const dot = initial.lastIndexOf(".");
        el.setSelectionRange(0, dot > 0 ? dot : initial.length);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [initial]);
  /** Enter keeps the editor open on a bad name and says why; leaving the
   *  field (blur) gives up on it instead. */
  const finish = (value: string, fromEnter: boolean) => {
    if (settled.current) return;
    const name = value.trim();
    const invalid = name && name !== initial ? entryNameError(name) : null;
    if (invalid && fromEnter) {
      toast.error(invalid);
      return;
    }
    settled.current = true;
    if (name && name !== initial && !invalid) onCommit(name);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      defaultValue={initial}
      aria-label={initial ? `Rename ${initial}` : "Name"}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settled.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value, false)}
      className="min-w-0 flex-1 rounded border border-border bg-panel-input px-1 py-0.5 font-sans text-sm text-foreground outline-none focus:border-border-strong"
    />
  );
}
