import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, File as FileIcon, Folder, FolderOpen, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { INDENT_PER_LEVEL, ROW_HEIGHT } from "../lib/tree-constants";

interface TreeRowProps {
  depth: number;
  /** True for folders/groups — renders a twisty chevron. */
  isDir: boolean;
  /** Folder open/closed state. Ignored when !isDir. */
  isExpanded?: boolean;
  isActive?: boolean;
  name: string;
  /** Tooltip on hover (commonly the full path). */
  title?: string;
  /** Receives the raw mouse event so callers can read ⌘/⇧ modifiers for
   *  multi-select. Keyboard activation (Space) calls it with no argument. */
  onClick: (e?: React.MouseEvent) => void;
  /** Enter on the focused row triggers this (macOS Finder rename
   *  convention). When omitted, Enter falls back to `onClick`. */
  onRename?: () => void;
  /** Part of a multi-selection — painted with the selection fill. */
  isSelected?: boolean;
  /** Absolute-positioning style from the virtualizer. */
  style?: CSSProperties;
  /** Optional leaf icon override (defaults to lucide `File`). Folders
   *  always render Folder/FolderOpen regardless of this. */
  leafIcon?: LucideIcon;
  /** Optional leaf icon rendered as inline content (e.g. an emoji glyph
   *  from page metadata). Takes precedence over `leafIcon`. */
  leafIconNode?: ReactNode;
  /** Optional trailing slot rendered at the row's right edge.
   *  Useful for hover-revealed actions (delete, new-file, etc.). */
  trailing?: ReactNode;
  /** When set, the name span renders as an input for inline rename /
   *  new-file flows. `onCommit(name)` fires on Enter/blur (with the
   *  trimmed value); `onCancel()` fires on Esc or empty commit. */
  editingMode?: "rename" | "new";
  initialValue?: string;
  onCommit?: (name: string) => void;
  onCancel?: () => void;
  /** Dim the row when its source path is on the clipboard via Cut. */
  isCut?: boolean;
  /** Hit-testing attributes for the pointer-based drag system. The
   *  drag hook resolves the hovered row via `document.elementFromPoint`
   *  + `closest("[data-tree-path]")`, so the path must live on the DOM
   *  node rather than being captured in a React closure. */
  dataPath?: string;
  /** Highlight this row as the active drop target. */
  isDropTarget?: boolean;
  /** Dim this row while it's the active drag source. */
  isDragging?: boolean;
  /** When set, paints a small git-status dot at the trailing edge. File names
   *  use the same color; folders retain their neutral typography. */
  gitColor?: string | null;
}

/**
 * One row in a virtualized tree. Extracted from FileTree so the
 * knowledge tree can reuse the exact same row chrome (indent, chevron,
 * hover state, active pill) — see plans/lexical-wibbling-elephant.md.
 */
export function TreeRow({
  depth,
  isDir,
  isExpanded,
  isActive,
  name,
  title,
  onClick,
  onRename,
  style,
  leafIcon: LeafIcon = FileIcon,
  leafIconNode,
  trailing,
  editingMode,
  initialValue,
  onCommit,
  onCancel,
  isCut,
  dataPath,
  isSelected,
  isDropTarget,
  isDragging,
  gitColor,
}: TreeRowProps) {
  const isEditing = !!editingMode;
  const inputRef = useRef<HTMLInputElement>(null);

  // Pre-select the basename (no extension) so renames feel like
  // Finder/VS Code — the user can immediately overwrite the stem.
  // Defer through rAF so Radix's ContextMenu focus-restore-to-trigger
  // (which runs synchronously on `onSelect`) has already happened by
  // the time we steal focus back to our input.
  useEffect(() => {
    if (!isEditing) return;
    let cancelled = false;
    const focusAndSelect = () => {
      if (cancelled) return;
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const value = el.value;
      if (editingMode === "rename" && value) {
        const dot = value.lastIndexOf(".");
        const end = dot > 0 ? dot : value.length;
        try {
          el.setSelectionRange(0, end);
        } catch {
          el.select();
        }
      } else {
        el.select();
      }
    };
    // Double-rAF to clear React's commit + Radix's focus restoration.
    const raf1 = window.requestAnimationFrame(() => {
      const raf2 = window.requestAnimationFrame(focusAndSelect);
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void raf2;
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(raf1);
    };
  }, [isEditing, editingMode]);
  // Rendered as a div (not <button>) so the optional `trailing` slot
  // can host real <button> children — nested buttons are invalid HTML
  // and trigger a React DOM-nesting error.
  return (
    <div
      role="button"
      tabIndex={isEditing ? -1 : 0}
      data-tree-path={dataPath}
      data-tree-is-dir={dataPath ? isDir : undefined}
      onClick={isEditing ? undefined : (e) => onClick(e)}
      onKeyDown={(e) => {
        if (isEditing) return;
        if (e.key === "Enter") {
          // macOS Finder: Enter renames the focused row.
          e.preventDefault();
          if (onRename) onRename();
          else onClick();
          return;
        }
        if (e.key === " ") {
          // Space still activates (open file / expand folder).
          e.preventDefault();
          onClick();
        }
      }}
      title={title}
      className={cn(
        "absolute left-0 right-0 flex items-center gap-1.5 text-left rounded-md mx-1",
        "transition-colors group select-none",
        isEditing ? "cursor-text" : "cursor-pointer",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-border-focus",
        // Selection fill (multi-select) takes visual priority over the
        // active-file pill; callers make the two mutually exclusive.
        isSelected
          ? "bg-bg-selected text-text-primary"
          : isActive
            ? "bg-[var(--bg-elevated)] text-text-primary"
            : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
        // Drop-target highlight — kept deliberately subtle to match
        // Atlas's monochromatic surfaces: a muted accent fill with a
        // hairline inset accent ring, not a heavy outline.
        isDropTarget &&
          "bg-[var(--accent-primary-muted)] ring-1 ring-inset ring-accent/40 text-text-primary",
        // Source row dimmed while drag is in flight.
        isDragging && "opacity-40",
        isCut && "opacity-50",
      )}
      style={{
        height: ROW_HEIGHT - 2,
        top: 1,
        // Base 2px lands the chevron at 12px from the panel edge,
        // matching the header's `px-3` so the name aligns vertically
        // with the panel title (see comment in file-tree.tsx).
        paddingLeft: 2 + depth * INDENT_PER_LEVEL,
        paddingRight: 6,
        ...style,
      }}
    >
      {/* The left slot is intentionally stable: a folder always owns its
          chevron and a file always owns its spacer. Git state lives beside the
          filename at the row's trailing edge, where it cannot displace either. */}
      {isDir ? (
        <ChevronRight
          size={12}
          className={cn(
            "shrink-0 text-text-tertiary transition-transform",
            isExpanded && "rotate-90",
          )}
          strokeWidth={2}
        />
      ) : (
        <span className="w-3 shrink-0" aria-hidden />
      )}

      {isDir ? (
        isExpanded ? (
          <FolderOpen size={13} className="shrink-0 text-text-tertiary" strokeWidth={1.5} />
        ) : (
          <Folder size={13} className="shrink-0 text-text-tertiary" strokeWidth={1.5} />
        )
      ) : leafIconNode ? (
        <span
          className="shrink-0 inline-flex items-center justify-center"
          style={{ width: 13, height: 13, fontSize: 12, lineHeight: 1 }}
        >
          {leafIconNode}
        </span>
      ) : (
        <LeafIcon size={13} className="shrink-0 text-text-tertiary" strokeWidth={1.5} />
      )}

      {isEditing ? (
        <input
          ref={inputRef}
          defaultValue={initialValue ?? name}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              const v = (e.currentTarget.value ?? "").trim();
              if (v) onCommit?.(v);
              else onCancel?.();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel?.();
            }
          }}
          onBlur={(e) => {
            const v = (e.currentTarget.value ?? "").trim();
            if (v && v !== (initialValue ?? name)) onCommit?.(v);
            else onCancel?.();
          }}
          className={cn(
            "flex-1 min-w-0 font-mono text-[11px] leading-4 bg-bg-input border border-border-default rounded px-1 py-0.5",
            "text-text-primary outline-none focus:border-border-focus",
          )}
        />
      ) : (
        <span
          className={cn(
            "truncate font-mono text-[11px] leading-4 flex-1 min-w-0",
            isDir && "text-text-primary",
          )}
          style={!isDir && gitColor ? { color: gitColor } : undefined}
        >
          {name}
        </span>
      )}

      {!isEditing && gitColor ? (
        <span
          className="ml-auto grid h-3 w-3 shrink-0 place-items-center"
          aria-label={isDir ? "Contains changed files" : "Git status changed"}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: gitColor }} />
        </span>
      ) : null}

      {trailing && !isEditing ? (
        <span className="shrink-0 flex items-center gap-0.5">{trailing}</span>
      ) : null}
    </div>
  );
}
