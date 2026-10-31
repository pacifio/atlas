import type { CSSProperties, ReactNode } from "react";
import { ChevronRight, File as FileIcon, Folder, FolderOpen, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { INDENT_PER_LEVEL, ROW_HEIGHT } from "@/features/explorer/lib/tree-constants";

interface KnowledgeTreeRowProps {
  depth: number;
  /** True for folders/groups — renders a twisty chevron. */
  isDir: boolean;
  /** Folder open/closed state. Ignored when !isDir. */
  isExpanded?: boolean;
  isActive?: boolean;
  name: string;
  /** Tooltip on hover (commonly the full path). */
  title?: string;
  /** Click, or Enter / Space on the focused row. */
  onClick: () => void;
  /** Absolute-positioning style from the virtualizer. */
  style?: CSSProperties;
  /** Leaf icon (defaults to lucide `File`). Folders always render
   *  Folder/FolderOpen. */
  leafIcon?: LucideIcon;
  /** Leaf icon rendered as inline content (a page's emoji). Takes precedence
   *  over `leafIcon`. */
  leafIconNode?: ReactNode;
  /** Hover-revealed actions at the row's right edge. */
  trailing?: ReactNode;
}

/**
 * One row of the knowledge tree: indent, chevron, icon and name, at the
 * project tree's row height and indent so the two read alike.
 */
export function KnowledgeTreeRow({
  depth,
  isDir,
  isExpanded,
  isActive,
  name,
  title,
  onClick,
  style,
  leafIcon: LeafIcon = FileIcon,
  leafIconNode,
  trailing,
}: KnowledgeTreeRowProps) {
  // Rendered as a div (not <button>) so the optional `trailing` slot
  // can host real <button> children — nested buttons are invalid HTML
  // and trigger a React DOM-nesting error.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      title={title}
      className={cn(
        "absolute left-0 right-0 flex items-center gap-1.5 text-left rounded-md mx-1",
        "transition-colors group select-none cursor-pointer",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-border-strong",
        isActive
          ? "bg-[var(--card)] text-foreground"
          : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
      )}
      style={{
        height: ROW_HEIGHT - 2,
        top: 1,
        paddingLeft: 2 + depth * INDENT_PER_LEVEL,
        paddingRight: 6,
        ...style,
      }}
    >
      {isDir ? (
        <ChevronRight
          size={12}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            isExpanded && "rotate-90",
          )}
          strokeWidth={2}
        />
      ) : (
        <span className="w-3 shrink-0" aria-hidden />
      )}

      {leafIconNode && !isDir ? (
        <span
          className="shrink-0 inline-flex items-center justify-center text-sm"
          style={{ width: 13, height: 13, lineHeight: 1 }}
        >
          {leafIconNode}
        </span>
      ) : isDir ? (
        isExpanded ? (
          <FolderOpen size={13} className="shrink-0 text-muted-foreground" strokeWidth={1.5} />
        ) : (
          <Folder size={13} className="shrink-0 text-muted-foreground" strokeWidth={1.5} />
        )
      ) : (
        <LeafIcon size={13} className="shrink-0 text-muted-foreground" strokeWidth={1.5} />
      )}

      <span
        className={cn(
          "truncate font-mono text-xs leading-4 flex-1 min-w-0",
          isDir && "text-foreground",
        )}
      >
        {name}
      </span>

      {trailing ? <span className="shrink-0 flex items-center gap-0.5">{trailing}</span> : null}
    </div>
  );
}
