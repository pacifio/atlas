import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Trash2, FileText } from "lucide-react";
import { TreeRow } from "@/features/explorer/components/tree-row";
import { ROW_HEIGHT } from "@/features/explorer/lib/tree-constants";

/** Imperative handle exposed to the sidebar so its header buttons can
 *  drive collapse-all / expand-all without lifting `expanded` state. */
export interface KnowledgeTreeHandle {
  collapseAll(): void;
  expandAll(): void;
}

export interface KnowledgeTreeEntry {
  id: string;
  title: string;
  /** Optional per-page emoji/glyph — when set, rendered as the leaf
   *  icon in place of the default file glyph. Fed from `meta.icon`. */
  icon?: string | null;
}

interface KnowledgeNode {
  /** Path-like key: folder path or full entry id. */
  key: string;
  name: string;
  depth: number;
  isDir: boolean;
  /** Present only for leaf entries. */
  entry?: KnowledgeTreeEntry;
}

interface KnowledgeTreeProps {
  entries: KnowledgeTreeEntry[];
  activeEntryId: string | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  /** Fired whenever the set of expanded directories changes so the
   *  sidebar can flip its collapse-all/expand-all button icon. */
  onExpandedCountChange?: (count: number) => void;
}

/**
 * Mirror of FileTree for the knowledge base. Entries arrive flat from
 * `list_knowledge` with slash-delimited ids ("notes/foo/note-123"),
 * so the tree is reconstructed client-side rather than via a new
 * Tauri command — knowledge dirs are small.
 *
 * Visually identical to the project explorer: same row height, indent,
 * chevron, hover/active states. See plans/lexical-wibbling-elephant.md.
 */
export const KnowledgeTree = forwardRef<KnowledgeTreeHandle, KnowledgeTreeProps>(
  function KnowledgeTree(
    { entries, activeEntryId, onSelect, onDelete, onExpandedCountChange },
    ref,
  ) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const scrollRef = useRef<HTMLDivElement>(null);

    // Surface the expanded count so the sidebar header can flip its
    // FoldVertical / UnfoldVertical icon between collapse-all and
    // expand-all without us lifting the whole `expanded` set into the
    // parent.
    useEffect(() => {
      onExpandedCountChange?.(expanded.size);
    }, [expanded, onExpandedCountChange]);

    // Build directory map: folder path → { dirs: Set, files: entries[] }.
    // Dedupe entries by id — `list_knowledge` can occasionally surface
    // the same note twice (e.g. when an import races a manual save) and
    // React keys must be unique.
    const dirMap = useMemo(() => {
      const map = new Map<string, { dirs: Set<string>; files: KnowledgeTreeEntry[] }>();
      const ensure = (path: string) => {
        if (!map.has(path)) map.set(path, { dirs: new Set(), files: [] });
        return map.get(path)!;
      };
      ensure("");
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const parts = entry.id.split("/");
        const fileName = parts[parts.length - 1];
        const dirParts = parts.slice(0, -1);
        let parent = "";
        for (let i = 0; i < dirParts.length; i++) {
          const here = dirParts.slice(0, i + 1).join("/");
          ensure(parent).dirs.add(here);
          ensure(here);
          parent = here;
        }
        ensure(dirParts.join("/")).files.push({
          ...entry,
          title: entry.title || fileName,
        });
      }
      return map;
    }, [entries]);

    // Flatten for the virtualizer, honoring `expanded`. Folders sort
    // before files at every level; both sort alphabetically.
    const flat = useMemo<KnowledgeNode[]>(() => {
      const out: KnowledgeNode[] = [];
      const walk = (path: string, depth: number) => {
        const node = dirMap.get(path);
        if (!node) return;
        const dirs = Array.from(node.dirs).sort();
        const files = [...node.files].sort((a, b) => a.title.localeCompare(b.title));
        for (const dir of dirs) {
          const name = dir.includes("/") ? dir.substring(dir.lastIndexOf("/") + 1) : dir;
          out.push({ key: dir, name, depth, isDir: true });
          if (expanded.has(dir)) walk(dir, depth + 1);
        }
        for (const file of files) {
          out.push({ key: file.id, name: file.title, depth, isDir: false, entry: file });
        }
      };
      walk("", 0);
      return out;
    }, [dirMap, expanded]);

    const virtualizer = useVirtualizer({
      count: flat.length,
      getScrollElement: () => scrollRef.current,
      estimateSize: () => ROW_HEIGHT,
      overscan: 15,
    });

    // Every directory key that exists in the dirMap (excluding the
    // virtual root ""). Used by `expandAll()`.
    const allDirKeys = useMemo(() => {
      const keys: string[] = [];
      for (const key of dirMap.keys()) {
        if (key === "") continue;
        keys.push(key);
      }
      return keys;
    }, [dirMap]);

    useImperativeHandle(
      ref,
      () => ({
        collapseAll: () => setExpanded(new Set()),
        expandAll: () => setExpanded(new Set(allDirKeys)),
      }),
      [allDirKeys],
    );

    const toggleDir = (key: string) =>
      setExpanded((s) => {
        const n = new Set(s);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      });

    if (entries.length === 0) {
      return (
        <div className="px-3 py-4 text-[11px] text-text-tertiary text-center">No notes yet</div>
      );
    }

    return (
      <div ref={scrollRef} className="flex-1 overflow-auto hide-scrollbar px-1.5 pb-2 min-h-0">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const node = flat[virtualRow.index];
            const isActive = !node.isDir && node.key === activeEntryId;
            return (
              <TreeRow
                // Compose with isDir to disambiguate the rare case where a
                // folder and a file share the same path string.
                key={`${node.isDir ? "d" : "f"}:${node.key}`}
                depth={node.depth}
                isDir={node.isDir}
                isExpanded={node.isDir ? expanded.has(node.key) : undefined}
                isActive={isActive}
                name={node.name}
                title={node.key}
                leafIcon={FileText}
                leafIconNode={
                  node.entry?.icon ? (
                    <span style={{ fontSize: 12, lineHeight: 1 }}>{node.entry.icon}</span>
                  ) : undefined
                }
                onClick={() => {
                  if (node.isDir) toggleDir(node.key);
                  else onSelect(node.key);
                }}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                trailing={
                  !node.isDir && onDelete ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(node.key);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:text-error text-text-tertiary transition-opacity"
                      title="Delete note"
                    >
                      <Trash2 size={11} />
                    </button>
                  ) : null
                }
              />
            );
          })}
        </div>
      </div>
    );
  },
);
