import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";
import { IconPicker } from "@/features/knowledge/components/icon-picker";
import { useCanvasStore, type PageTreeEntry } from "../stores/canvas-store";

/** Default page emoji, mirrored in the canvas header pill. */
export const DEFAULT_PAGE_ICON = "📜";

/**
 * Left docked pages list for Spaces — Figma-style flat pages (no folders),
 * each renamable with an emoji (KB-note convention). Index-driven (flat `tree`),
 * reuses the KB `IconPicker` for emoji.
 */
export function PagesPanel({ width = 240 }: { width?: number }) {
  const tree = useCanvasStore.use.tree();
  const activePageId = useCanvasStore.use.activePageId();
  const { createPage, setActivePage, renameTreeEntry, setTreeEntryIcon, deleteTreeEntry } =
    useCanvasStore.use.actions();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [iconFor, setIconFor] = useState<{ id: string; rect: DOMRect } | null>(null);

  const pages = tree
    .filter((e) => e.kind === "page")
    .slice()
    .sort((a, b) => a.order - b.order);

  const iconEntry = iconFor ? (tree.find((e) => e.id === iconFor.id) ?? null) : null;

  const renderEntry = (entry: PageTreeEntry): React.ReactNode => {
    const active = entry.id === activePageId;
    return (
      <div
        key={entry.id}
        className={cn(
          "group/row flex h-control-md items-center gap-1.5 rounded px-1.5 text-xs cursor-pointer",
          active
            ? "bg-element-selected text-foreground"
            : "text-secondary-foreground hover:bg-element-hover",
        )}
        onClick={() => setActivePage(entry.id)}
      >
        {/* Emoji — click opens the picker */}
        <Hint label="Change icon">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIconFor({ id: entry.id, rect: e.currentTarget.getBoundingClientRect() });
            }}
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-element-hover"
          >
            <span className="text-xs leading-none">{entry.icon || DEFAULT_PAGE_ICON}</span>
          </button>
        </Hint>

        {/* Name / inline rename */}
        {editingId === entry.id ? (
          <input
            autoFocus
            defaultValue={entry.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v) renameTreeEntry(entry.id, v);
              setEditingId(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              else if (e.key === "Escape") setEditingId(null);
            }}
            className="min-w-0 flex-1 rounded bg-panel-input px-1 text-xs text-foreground outline-none"
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditingId(entry.id);
            }}
          >
            {entry.name || "Untitled"}
          </span>
        )}

        {/* Delete */}
        <Hint label="Delete page">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              deleteTreeEntry(entry.id);
            }}
            className="hidden shrink-0 rounded p-0.5 text-muted-foreground hover:text-error group-hover/row:block"
          >
            <Trash2 size={11} />
          </button>
        </Hint>
      </div>
    );
  };

  return (
    <div
      className="flex h-full shrink-0 flex-col border-r border-border bg-[var(--card)]"
      style={{ width }}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 px-2 pl-3">
        <span className="flex-1 text-2xs font-semibold uppercase leading-none tracking-wider text-muted-foreground">
          Pages
        </span>
        <Hint label="New page">
          <button
            type="button"
            onClick={() => createPage(null)}
            className="flex h-5 w-5 items-center justify-center rounded-full border border-border text-secondary-foreground hover:bg-element-hover hover:text-foreground outline-none transition-colors cursor-pointer"
          >
            <Plus size={12} />
          </button>
        </Hint>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar py-1 px-1.5">
        {pages.map((e) => renderEntry(e))}
      </div>

      {iconFor && iconEntry && (
        <IconPicker
          value={iconEntry.icon ?? null}
          anchorRect={iconFor.rect}
          onPick={(v) => setTreeEntryIcon(iconFor.id, v)}
          onClose={() => setIconFor(null)}
        />
      )}
    </div>
  );
}
