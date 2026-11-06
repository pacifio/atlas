import { useState } from "react";
import { CanvasPagesPanel, type CanvasPageRow } from "@tryatlas/design";
import { IconPicker } from "@/features/knowledge/components/icon-picker";
import { useCanvasStore } from "../stores/canvas-store";

/** Default page emoji, mirrored in the canvas header pill. */
export const DEFAULT_PAGE_ICON = "📜";

/**
 * Left docked pages list for the local board: flat pages (no folders, no
 * reordering), each renamable with an emoji (KB-note convention). Double-click
 * renames; the emoji opens the KB `IconPicker`; the store refuses to delete the
 * last page.
 */
export function PagesPanel() {
  const tree = useCanvasStore.use.tree();
  const activePageId = useCanvasStore.use.activePageId();
  const { createPage, setActivePage, renameTreeEntry, setTreeEntryIcon, deleteTreeEntry } =
    useCanvasStore.use.actions();

  const [iconFor, setIconFor] = useState<{ id: string; rect: DOMRect } | null>(null);

  const rows: CanvasPageRow[] = tree
    .filter((e) => e.kind === "page")
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((e) => ({
      id: e.id,
      kind: "page",
      // The panel draws "Untitled" for an empty name and renames from the real one.
      name: e.name,
      icon: e.icon || DEFAULT_PAGE_ICON,
      depth: 0,
    }));

  const iconEntry = iconFor ? (tree.find((e) => e.id === iconFor.id) ?? null) : null;

  return (
    <>
      <CanvasPagesPanel
        className="w-[240px]"
        rows={rows}
        activeId={activePageId}
        onOpen={setActivePage}
        onCreate={() => createPage(null)}
        onRename={(id, name) => {
          const v = name.trim();
          if (v) renameTreeEntry(id, v);
        }}
        onDelete={deleteTreeEntry}
        deleteLabel={() => "Delete page"}
        onIconClick={(id, rect) => setIconFor({ id, rect })}
      />
      {iconFor && iconEntry && (
        <IconPicker
          value={iconEntry.icon ?? null}
          anchorRect={iconFor.rect}
          onPick={(v) => setTreeEntryIcon(iconFor.id, v)}
          onClose={() => setIconFor(null)}
        />
      )}
    </>
  );
}
