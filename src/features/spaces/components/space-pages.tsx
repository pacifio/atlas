import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, FilePlus2, FolderPlus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/tooltip";
import { CommsAvatar } from "@/features/comms/components/comms-avatar";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { SPACE_PAGE_NAME_MAX } from "../lib/space-wire";
import type { SpacePage } from "../lib/spaces-api";
import type { SpaceSession } from "../lib/use-space-session";
import { useSpacesStore } from "../stores/spaces-store";

/**
 * The pages sidebar — the local Spaces panel's chrome (quiet header,
 * circular compact buttons) over the server-authoritative tree, with rows in
 * the drafts-list shape: name over "Updated …", author on the right. Always
 * the left column; the TOOL dock is the movable one.
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
  const rows = useMemo(() => {
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

  const pageCount = pages.filter((p) => p.kind === "page").length;

  // ---- pointer drag with an insertion line --------------------------------
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; where: "before" | "after" | "into" } | null>(null);
  const pressed = useRef<{ id: string; x: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const hitTest = (
    e: React.PointerEvent,
  ): { id: string; where: "before" | "after" | "into" } | null => {
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

  const onListPointerMove = (e: React.PointerEvent) => {
    const p = pressed.current;
    if (!p) return;
    if (dragId === null) {
      if (Math.abs(e.clientX - p.x) < 5 && Math.abs(e.clientY - p.y) < 5) return;
      setDragId(p.id);
      listRef.current?.setPointerCapture(e.pointerId);
    }
    const next = hitTest(e);
    // Same target, same edge: keep the state identity so the list does not
    // re-render once per pointermove while nothing visible changed.
    setDrop((cur) => (cur?.id === next?.id && cur?.where === next?.where ? cur : next));
  };

  const onListPointerUp = () => {
    const src = dragId;
    const target = drop;
    pressed.current = null;
    setDragId(null);
    setDrop(null);
    if (!src || !target || !editable) return;
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
    <div
      className="flex h-full shrink-0 flex-col border-r border-border-default bg-[#090909]"
      style={{ width: 260 }}
    >
      {/* Quiet header — no divider, the local panel's recipe. */}
      <div className="flex h-8 shrink-0 items-center gap-1 px-2 pl-3">
        <span className="flex-1 text-[10px] font-semibold uppercase leading-none tracking-wider text-text-tertiary">
          Pages
        </span>
        <RoundButton
          label="New page"
          disabled={!editable}
          onClick={() => create({})}
          icon={<FilePlus2 size={10} />}
        />
        <RoundButton
          label="New folder"
          disabled={!editable}
          onClick={() => create({ kind: "folder" })}
          icon={<FolderPlus size={10} />}
        />
      </div>

      <div
        ref={listRef}
        className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-1.5 py-1"
        onPointerMove={onListPointerMove}
        onPointerUp={onListPointerUp}
      >
        {rows.map(({ page, depth }) => {
          const isFolder = page.kind === "folder";
          const active = page.id === activeId;
          const lastPage = !isFolder && pageCount <= 1;
          const dropHere = drop?.id === page.id;
          const authorId = authors?.[page.id];
          const author = authorId ? (members.find((m) => m.id === authorId) ?? null) : null;

          return (
            <div key={page.id} data-page-id={page.id} className="relative">
              {dropHere && drop.where !== "into" && (
                <div
                  className={cn(
                    "pointer-events-none absolute left-1 right-1 z-10 h-[2px] rounded bg-[var(--accent-primary)]",
                    drop.where === "before" ? "top-0" : "bottom-0",
                  )}
                />
              )}
              <div
                className={cn(
                  "group/row flex cursor-pointer items-center gap-2 rounded py-2 pr-2 text-[11px]",
                  active
                    ? "bg-bg-selected text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover",
                  dropHere && drop.where === "into" && "bg-bg-selected/60",
                  dragId === page.id && "opacity-50",
                )}
                style={{ paddingLeft: 6 + depth * 12 }}
                onPointerDown={(e) => {
                  if (!editable || renamingId !== null) return;
                  pressed.current = { id: page.id, x: e.clientX, y: e.clientY };
                }}
                onClick={() => {
                  if (isFolder) {
                    setCollapsed((cur) => {
                      const next = new Set(cur);
                      if (next.has(page.id)) next.delete(page.id);
                      else next.add(page.id);
                      return next;
                    });
                  } else {
                    session.openPage(page.id);
                  }
                }}
              >
                {isFolder && (
                  <ChevronRight
                    size={10}
                    className={cn(
                      "shrink-0 text-text-tertiary transition-transform",
                      !collapsed.has(page.id) && "rotate-90",
                    )}
                  />
                )}
                {/* Name over its updated-at, the drafts-row shape. */}
                <div className="min-w-0 flex-1">
                  {renamingId === page.id ? (
                    <input
                      autoFocus
                      maxLength={SPACE_PAGE_NAME_MAX}
                      defaultValue={page.name}
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        setRenamingId(null);
                        if (v && v !== page.name) session.renamePage(page.id, { name: v });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                        else if (e.key === "Escape") setRenamingId(null);
                      }}
                      className="w-full min-w-0 rounded bg-bg-input px-1 text-[11px] text-text-primary outline-none"
                    />
                  ) : (
                    <>
                      <span
                        className="block truncate text-[11.5px] font-medium leading-[1.35]"
                        onDoubleClick={(e) => {
                          if (!editable) return;
                          e.stopPropagation();
                          setRenamingId(page.id);
                        }}
                      >
                        {page.name || "Untitled"}
                      </span>
                      <span className="block truncate text-[10px] leading-[1.35] text-text-tertiary">
                        Updated {timeAgo(new Date(page.updated_at).toISOString(), { suffix: true })}
                      </span>
                    </>
                  )}
                </div>

                {/* The author, where this client can actually know it. */}
                {author && renamingId !== page.id && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex min-w-0 shrink-0 items-center gap-1">
                        <CommsAvatar member={author} size={16} />
                        <span className="max-w-[64px] truncate text-[9.5px] text-text-tertiary">
                          {firstName(author.name)}
                        </span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      Created by {author.name}
                    </TooltipContent>
                  </Tooltip>
                )}

                {editable && (
                  <span className="flex shrink-0 items-center gap-1">
                    {isFolder && (
                      <button
                        type="button"
                        title="New page inside"
                        onClick={(e) => {
                          e.stopPropagation();
                          create({ parent_id: page.id });
                        }}
                        className="hidden h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-full border border-border-default text-text-tertiary transition-colors hover:bg-bg-hover hover:text-text-primary group-hover/row:flex"
                      >
                        <FilePlus2 size={10} />
                      </button>
                    )}
                    {/* Always drawn, never hover-revealed: a delete that
                        appears under the cursor is a delete you click by
                        accident. */}
                    <button
                      type="button"
                      title={
                        lastPage
                          ? "The last page of a Space cannot be deleted."
                          : isFolder
                            ? `Delete folder “${page.name}” and everything in it`
                            : `Delete “${page.name}”`
                      }
                      disabled={lastPage}
                      onClick={(e) => {
                        e.stopPropagation();
                        session.deletePage(page.id);
                      }}
                      className="flex h-[22px] w-[22px] cursor-pointer items-center justify-center rounded-full border border-border-default text-text-tertiary transition-colors hover:bg-bg-hover hover:text-[var(--status-error)] disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      <Trash2 size={10} />
                    </button>
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div className="px-2 py-3 text-[10px] text-text-tertiary">No pages yet.</div>
        )}
      </div>
    </div>
  );
}

function RoundButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-border-default text-text-secondary outline-none transition-colors hover:bg-bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon}
    </button>
  );
}

function firstName(name: string | undefined): string {
  if (!name) return "Unknown";
  return name.trim().split(/\s+/)[0] ?? name;
}
