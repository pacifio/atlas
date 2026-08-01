import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
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
  const {
    createPage,
    setActivePage,
    renameTreeEntry,
    setTreeEntryIcon,
    deleteTreeEntry,
  } = useCanvasStore.use.actions();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [iconFor, setIconFor] = useState<{ id: string; rect: DOMRect } | null>(
    null,
  );

  const pages = tree
    .filter((e) => e.kind === "page")
    .slice()
    .sort((a, b) => a.order - b.order);

  const iconEntry = iconFor
    ? (tree.find((e) => e.id === iconFor.id) ?? null)
    : null;

  const renderEntry = (entry: PageTreeEntry): React.ReactNode => {
    const active = entry.id === activePageId;
    return (
      <div
        key={entry.id}
        className={cn(
          "group/row flex h-[26px] items-center gap-1.5 rounded px-1.5 text-[11px] cursor-pointer",
          active
            ? "bg-bg-selected text-text-primary"
            : "text-text-secondary hover:bg-bg-hover",
        )}
        onClick={() => setActivePage(entry.id)}
      >
        {/* Emoji — click opens the picker */}
        <button
          type="button"
          title="Change icon"
          onClick={(e) => {
            e.stopPropagation();
            setIconFor({
              id: entry.id,
              rect: e.currentTarget.getBoundingClientRect(),
            });
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded hover:bg-white/10"
        >
          <span className="text-[11px] leading-none">
            {entry.icon || DEFAULT_PAGE_ICON}
          </span>
        </button>

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
              if (e.key === "Enter")
                (e.currentTarget as HTMLInputElement).blur();
              else if (e.key === "Escape") setEditingId(null);
            }}
            className="min-w-0 flex-1 rounded bg-bg-input px-1 text-[11px] text-text-primary outline-none"
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
        <button
          type="button"
          title="Delete page"
          onClick={(e) => {
            e.stopPropagation();
            deleteTreeEntry(entry.id);
          }}
          className="hidden shrink-0 rounded p-0.5 text-text-tertiary hover:text-[var(--status-error)] group-hover/row:block"
        >
          <Trash2 size={11} />
        </button>
      </div>
    );
  };

  return (
    <div
      className="flex h-full shrink-0 flex-col border-r border-border-default bg-[var(--bg-secondary)]"
      style={{ width }}
    >
      <div className="flex h-8 shrink-0 items-center gap-1 px-2 pl-3">
        <span className="flex-1 text-[10px] font-semibold uppercase leading-none tracking-wider text-text-tertiary">
          Pages
        </span>
        <button
          type="button"
          title="New page"
          onClick={() => createPage(null)}
          className="flex h-5 w-5 items-center justify-center rounded-full border border-border-default text-text-secondary hover:bg-bg-hover hover:text-text-primary outline-none transition-colors cursor-pointer"
        >
          <Plus size={12} />
        </button>
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
