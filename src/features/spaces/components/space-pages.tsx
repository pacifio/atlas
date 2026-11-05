import { useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2 } from "lucide-react";
import {
  CanvasPagesPanel,
  type CanvasPageDropIndicator,
  type CanvasPageRow,
} from "@tryatlas/design";
import { timeAgo } from "@/lib/time-ago";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { SPACE_PAGE_NAME_MAX } from "../lib/space-wire";
import type { SpacePage } from "../lib/spaces-api";
import type { SpaceSession } from "../lib/use-space-session";
import { useSpacesStore } from "../stores/spaces-store";

/**
 * The pages sidebar: the package's `CanvasPagesPanel` over the
 * server-authoritative tree, with rows in the drafts-list shape (name over
 * "Updated …", author on the right). Always the left column; the TOOL dock is
 * the movable one.
 *
 * Deliberately non-optimistic: every row comes from the last `page.tree`
 * broadcast and every edit is one control frame. Reordering is a pointer
 * drag with an insertion line (halves = before/after, a folder's middle
 * third = into), resolved to ONE `page.move {parent_id, index}`. Naming a
 * new page is a second gesture: the create frame carries no name (the id is
 * the server's to pick), so when the next tree shows a new row under the
 * awaited parent, the rename editor opens on it.
 */
export function SpacePages({
  convId,
  session,
  editable,
}: {
  convId: string;
  session: SpaceSession;
  editable: boolean;
}) {
  const pages = session.meta?.pages ?? [];
  const activeId = session.pageId;
  const members = useCommsStore.use.members();
  const authors = useSpacesStore((s) => s.pageAuthors[convId]);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Create-then-rename: remember where we created; the next tree's new row
  // under that parent gets the editor.
  const awaiting = useRef<{ parentId: string | null } | null>(null);
  const knownIds = useRef<Set<string>>(new Set(pages.map((p) => p.id)));
  useEffect(() => {
    const fresh = pages.filter((p) => !knownIds.current.has(p.id));
    knownIds.current = new Set(pages.map((p) => p.id));
    const want = awaiting.current;
    if (!want) return;
    const created = fresh.find((p) => p.parent_id === want.parentId);
    if (created) {
      awaiting.current = null;
      setRenamingId(created.id);
      // The one moment this client can know an author truthfully.
      const me = useCommsStore.getState().me;
      if (me) useSpacesStore.getState().actions.notePageAuthor(convId, created.id, me);
    }
  }, [pages, convId]);

  // Flatten the (already depth-first) tree honoring collapsed folders.
  const flat = useMemo(() => {
    const byParent = new Map<string | null, SpacePage[]>();
    for (const p of pages) {
      const list = byParent.get(p.parent_id) ?? [];
      list.push(p);
      byParent.set(p.parent_id, list);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort);

    const out: Array<{ page: SpacePage; depth: number }> = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const p of byParent.get(parentId) ?? []) {
        out.push({ page: p, depth });
        if (p.kind === "folder" && !collapsed.has(p.id)) walk(p.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [pages, collapsed]);

  const rows: CanvasPageRow[] = flat.map(({ page, depth }) => {
    const authorId = authors?.[page.id];
    // The author, where this client can actually know it.
    const author = authorId ? (members.find((m) => m.id === authorId) ?? null) : null;
    return {
      id: page.id,
      kind: page.kind === "folder" ? "folder" : "page",
      name: page.name,
      icon: page.icon ?? undefined,
      subtitle:
        page.kind === "folder"
          ? undefined
          : `Updated ${timeAgo(new Date(page.updated_at).toISOString(), { suffix: true })}`,
      depth,
      author: author ? { name: author.name, image: author.image } : undefined,
    };
  });

  // Counted over the whole tree: a collapsed folder hides pages from `rows`.
  const pageCount = pages.filter((p) => p.kind === "page").length;

  // ---- pointer drag with an insertion line --------------------------------
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<CanvasPageDropIndicator | null>(null);
  const pressed = useRef<{ id: string; x: number; y: number } | null>(null);

  const isDescendant = (maybeChild: string, ancestor: string): boolean => {
    const byId = new Map(pages.map((p) => [p.id, p]));
    let cur: string | null = maybeChild;
    while (cur !== null) {
      const p = byId.get(cur);
      if (!p) return false;
      if (p.parent_id === ancestor) return true;
      cur = p.parent_id;
    }
    return false;
  };

  const hitTest = (e: React.PointerEvent): CanvasPageDropIndicator | null => {
    const el = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>("[data-page-id]");
    if (!el) return null;
    const id = el.dataset.pageId;
    if (!id || id === dragId) return null;
    const rect = el.getBoundingClientRect();
    const frac = (e.clientY - rect.top) / rect.height;
    const target = pages.find((p) => p.id === id);
    if (!target) return null;
    if (target.kind === "folder" && frac > 0.3 && frac < 0.7) return { id, where: "into" };
    return { id, where: frac < 0.5 ? "before" : "after" };
  };

  const onRowPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pressed.current;
    if (!p) return;
    // Released somewhere no row heard it: not a drag.
    if (e.buttons === 0) {
      pressed.current = null;
      return;
    }
    if (dragId === null) {
      if (Math.abs(e.clientX - p.x) < 5 && Math.abs(e.clientY - p.y) < 5) return;
      setDragId(p.id);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const next = hitTest(e);
    // Same target, same edge: keep the state identity so the list does not
    // re-render once per pointermove while nothing visible changed.
    setDrop((cur) => (cur?.id === next?.id && cur?.where === next?.where ? cur : next));
  };

  const onRowPointerUp = () => {
    const src = dragId;
    const target = drop;
    pressed.current = null;
    setDragId(null);
    setDrop(null);
    if (!src) return;
    // The captured row gets the click that ends a drag: it must not open
    // the page (or fold the folder) that was just dragged.
    const swallow = (e: MouseEvent) => e.stopPropagation();
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
    if (!target || !editable) return;
    const dragged = pages.find((p) => p.id === src);
    const over = pages.find((p) => p.id === target.id);
    if (!dragged || !over) return;
    // Cycle guard client-side too (the server refuses anyway).
    if (dragged.kind === "folder" && (target.id === src || isDescendant(target.id, src))) return;

    if (target.where === "into") {
      session.movePage(src, target.id, 0);
      return;
    }
    // The desired index within the DESTINATION parent's list; the server
    // clamps and renumbers densely from there.
    const parentId = over.parent_id;
    const siblings = pages.filter((p) => p.parent_id === parentId).sort((a, b) => a.sort - b.sort);
    let index = siblings.findIndex((p) => p.id === target.id);
    if (target.where === "after") index += 1;
    // Removing the dragged row from earlier in the same list shifts the slot.
    const from = siblings.findIndex((p) => p.id === src);
    if (from !== -1 && from < index) index -= 1;
    session.movePage(src, parentId, Math.max(0, index));
  };

  const create = (opts: { kind?: "page" | "folder"; parent_id?: string | null }) => {
    awaiting.current = { parentId: opts.parent_id ?? null };
    session.createPage(opts);
  };

  return (
    <CanvasPagesPanel
      className="w-[260px]"
      rows={rows}
      activeId={activeId}
      collapsedIds={collapsed}
      onToggleFolder={(id) =>
        setCollapsed((cur) => {
          const next = new Set(cur);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })
      }
      onOpen={(id) => session.openPage(id)}
      onCreate={editable ? (kind) => create(kind === "folder" ? { kind } : {}) : undefined}
      allowFolders
      renamingId={renamingId}
      onRenamingChange={setRenamingId}
      onRename={
        editable
          ? (id, name) => session.renamePage(id, { name: name.slice(0, SPACE_PAGE_NAME_MAX) })
          : undefined
      }
      onDelete={editable ? (id) => session.deletePage(id) : undefined}
      // Always drawn, never hover-revealed: a delete that appears under the
      // cursor is a delete you click by accident.
      deleteMode="always"
      deleteLabel={(row) =>
        row.kind === "folder"
          ? `Delete folder “${row.name}” and everything in it`
          : `Delete “${row.name}”`
      }
      lastPageLabel="The last page of a Space cannot be deleted."
      pageCount={pageCount}
      rowActions={(row) =>
        editable && row.kind === "folder"
          ? [
              {
                id: "new-page",
                label: "New page inside",
                icon: FilePlus2,
                onSelect: (id) => create({ parent_id: id }),
              },
            ]
          : []
      }
      dropIndicator={drop}
      getRowProps={(id) => ({
        onPointerDown: (e) => {
          if (!editable || renamingId !== null || e.button !== 0) return;
          pressed.current = { id, x: e.clientX, y: e.clientY };
        },
        onPointerMove: onRowPointerMove,
        onPointerUp: onRowPointerUp,
        className: dragId === id ? "opacity-50" : undefined,
      })}
    />
  );
}
