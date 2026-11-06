import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Trash2, FileText } from "lucide-react";
import { KnowledgeTreeRow } from "./knowledge-tree-row";
import { ROW_HEIGHT } from "@/features/explorer/lib/tree-constants";
import { EmptyState, Hint, Icon } from "@tryatlas/design";

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

/** A row's identity: a folder and a note can share a path string. */
const treeIdOf = (node: Pick<KnowledgeNode, "key" | "isDir">) =>
  `${node.isDir ? "d" : "f"}:${node.key}`;

/** How long typed letters keep adding to one type-ahead search. */
const TYPE_AHEAD_MS = 500;

/**
 * The knowledge base as a virtualized tree. Entries arrive flat from
 * `list_knowledge` with slash-delimited ids ("notes/foo/note-123"),
 * so the tree is reconstructed client-side rather than via a new
 * Tauri command — knowledge dirs are small.
 *
 * Visually identical to the project explorer: same row height, indent,
 * chevron, hover/active states. See plans/lexical-wibbling-elephant.md.
 *
 * An ARIA tree with one Tab stop (the last-focused row, else the open page,
 * else the first row). Up/Down move, Right opens a folder or steps into it,
 * Left closes it or steps out to its parent, Home/End jump to the ends, and
 * typing a name's first letters jumps to the next row that starts with them.
 * Opening a page from anywhere else opens its folders and scrolls it into view.
 */
export const KnowledgeTree = forwardRef<KnowledgeTreeHandle, KnowledgeTreeProps>(
  function KnowledgeTree(
    { entries, activeEntryId, onSelect, onDelete, onExpandedCountChange },
    ref,
  ) {
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [focusId, setFocusId] = useState<string | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    // A row the keyboard moved to that the virtualizer may not have drawn
    // yet: focused on the first render that has it.
    const pendingFocus = useRef<string | null>(null);
    // The page to scroll into view once its folders are open.
    const pendingReveal = useRef<string | null>(null);
    const typeAhead = useRef({ text: "", at: 0 });

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

    // A page opened from outside the tree (the finder, a backlink, recents):
    // open its folders, then scroll it into view once the rows exist.
    useEffect(() => {
      if (!activeEntryId) return;
      const parts = activeEntryId.split("/");
      const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
      if (ancestors.length > 0) {
        setExpanded((s) => {
          if (ancestors.every((a) => s.has(a))) return s;
          const n = new Set(s);
          for (const a of ancestors) n.add(a);
          return n;
        });
      }
      pendingReveal.current = treeIdOf({ key: activeEntryId, isDir: false });
    }, [activeEntryId]);

    useEffect(() => {
      const want = pendingReveal.current;
      if (!want) return;
      const index = flat.findIndex((n) => treeIdOf(n) === want);
      if (index < 0) return;
      pendingReveal.current = null;
      virtualizer.scrollToIndex(index, { align: "auto" });
    }, [flat, virtualizer]);

    // Focus the row the keyboard moved to, as soon as it is drawn.
    useEffect(() => {
      const want = pendingFocus.current;
      if (!want) return;
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[data-tree-id="${CSS.escape(want)}"]`,
      );
      if (!row) return;
      pendingFocus.current = null;
      row.focus();
    });

    // The Tab stop: the last-focused row while it is still visible, else
    // the open page, else the first row.
    const activeId = activeEntryId ? treeIdOf({ key: activeEntryId, isDir: false }) : null;
    const tabStopId =
      (focusId && flat.some((n) => treeIdOf(n) === focusId) ? focusId : null) ??
      (activeId && flat.some((n) => treeIdOf(n) === activeId) ? activeId : null) ??
      (flat[0] ? treeIdOf(flat[0]) : null);

    const moveTo = (index: number) => {
      const node = flat[index];
      if (!node) return;
      const id = treeIdOf(node);
      setFocusId(id);
      pendingFocus.current = id;
      virtualizer.scrollToIndex(index, { align: "auto" });
    };

    const onTreeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Only a row's keys: a key on its Delete button is the button's.
      if ((e.target as HTMLElement).getAttribute("role") !== "treeitem") return;
      const at = flat.findIndex((n) => treeIdOf(n) === tabStopId);
      if (at < 0) return;
      const node = flat[at];
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveTo(Math.min(at + 1, flat.length - 1));
          return;
        case "ArrowUp":
          e.preventDefault();
          moveTo(Math.max(at - 1, 0));
          return;
        case "Home":
          e.preventDefault();
          moveTo(0);
          return;
        case "End":
          e.preventDefault();
          moveTo(flat.length - 1);
          return;
        case "ArrowRight":
          e.preventDefault();
          if (!node.isDir) return;
          if (!expanded.has(node.key)) toggleDir(node.key);
          else if (flat[at + 1] && flat[at + 1].depth > node.depth) moveTo(at + 1);
          return;
        case "ArrowLeft": {
          e.preventDefault();
          if (node.isDir && expanded.has(node.key)) {
            toggleDir(node.key);
            return;
          }
          const slash = node.key.lastIndexOf("/");
          if (slash < 0) return;
          const parent = treeIdOf({ key: node.key.slice(0, slash), isDir: true });
          const parentAt = flat.findIndex((n) => treeIdOf(n) === parent);
          if (parentAt >= 0) moveTo(parentAt);
          return;
        }
      }
      // Type-ahead: printable characters, gathered while typed in quick succession.
      if (e.key.length !== 1 || (e.key === " " && !typeAhead.current.text)) return;
      const now = Date.now();
      const fresh = now - typeAhead.current.at > TYPE_AHEAD_MS;
      const text = (fresh ? "" : typeAhead.current.text) + e.key.toLowerCase();
      typeAhead.current = { text, at: now };
      // A new search starts after the current row; a growing one may stay on it.
      const start = text.length === 1 ? at + 1 : at;
      for (let step = 0; step < flat.length; step++) {
        const index = (start + step) % flat.length;
        if (flat[index].name.toLowerCase().startsWith(text)) {
          e.preventDefault();
          moveTo(index);
          return;
        }
      }
    };

    if (entries.length === 0) {
      return <EmptyState icon={FileText} title="No notes yet" />;
    }

    return (
      <div
        ref={scrollRef}
        role="tree"
        aria-label="Notes"
        onKeyDown={onTreeKeyDown}
        className="flex-1 overflow-auto hide-scrollbar px-1.5 pb-2 min-h-0"
      >
        <div role="none" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const node = flat[virtualRow.index];
            const id = treeIdOf(node);
            const isActive = !node.isDir && node.key === activeEntryId;
            const isTabStop = id === tabStopId;
            return (
              <KnowledgeTreeRow
                key={id}
                treeId={id}
                depth={node.depth}
                isDir={node.isDir}
                isExpanded={node.isDir ? expanded.has(node.key) : undefined}
                isActive={isActive}
                isTabStop={isTabStop}
                name={node.name}
                title={node.key}
                leafIcon={FileText}
                leafIconNode={
                  node.entry?.icon ? (
                    <span className="text-sm leading-none">{node.entry.icon}</span>
                  ) : undefined
                }
                onClick={() => {
                  if (node.isDir) toggleDir(node.key);
                  else onSelect(node.key);
                }}
                onFocus={() => setFocusId(id)}
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                trailing={
                  !node.isDir && onDelete ? (
                    <Hint label="Delete note">
                      <button
                        type="button"
                        aria-label="Delete note"
                        // Reachable by Tab from its own row only, so the tree
                        // stays one stop plus the focused row's action.
                        tabIndex={isTabStop ? 0 : -1}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(node.key);
                        }}
                        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 rounded hover:text-error text-muted-foreground transition-opacity"
                      >
                        <Icon icon={Trash2} size="sm" />
                      </button>
                    </Hint>
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
