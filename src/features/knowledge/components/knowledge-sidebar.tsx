import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Menu as DropdownMenu } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";
import { logEvent } from "@/features/log/lib/log";
import {
  FolderPlus,
  FilePlus,
  FoldVertical,
  GitBranch,
  Network,
  Trash2,
  UnfoldVertical,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Folder,
} from "lucide-react";
import { KnowledgeTree, type KnowledgeTreeHandle } from "./knowledge-tree";
import { Hint, HintGroup, HintItem } from "@tryatlas/design";

interface KnowledgeSidebarProps {
  projectPath: string;
  entries: Array<{ id: string; title: string; icon?: string | null }>;
  activeEntryId: string | null;
  activeRepoName: string | null;
  recentIds: string[];
  /** Clear the "Recently opened" list. */
  onClearRecents: () => void;
  /** Click a note */
  onSelectEntry: (id: string) => void;
  onDeleteEntry: (id: string) => void;
  onNewFolder: () => void;
  onNewNote: () => void;
  /** Import external `.md` files into the KB. */
  onImportFiles: () => void;
  /** Import a folder (e.g. an Obsidian vault) into the KB. */
  onImportFolder: () => void;
  onOpenGraph: () => void;
  onSelectRepo: (name: string) => void;
  /** True while the inline folder-name input is open. Rendered just
   *  under the sidebar header so it doesn't overlap tree rows. */
  folderInputOpen?: boolean;
  folderInputValue?: string;
  onFolderInputChange?: (v: string) => void;
  onFolderInputCommit?: () => void;
  onFolderInputCancel?: () => void;
  /** Current resolved width in px (parent owns the resizable state). */
  width?: number;
}

export function KnowledgeSidebar({
  projectPath,
  entries,
  activeEntryId,
  activeRepoName,
  recentIds,
  onClearRecents,
  onSelectEntry,
  onDeleteEntry,
  onNewFolder,
  onNewNote,
  onImportFiles,
  onImportFolder,
  onOpenGraph,
  onSelectRepo,
  folderInputOpen,
  folderInputValue = "",
  onFolderInputChange,
  onFolderInputCommit,
  onFolderInputCancel,
  width = 260,
}: KnowledgeSidebarProps) {
  const [clonedRepos, setClonedRepos] = useState<
    Array<{ name: string; display_name: string; path: string; has_readme: boolean }>
  >([]);

  // Imperative handle on the KnowledgeTree so the header can drive
  // collapse-all / expand-all without lifting the tree's expanded set
  // into the sidebar (matches the explorer's collapseAll pattern).
  const treeRef = useRef<KnowledgeTreeHandle>(null);
  const [treeExpandedCount, setTreeExpandedCount] = useState(0);
  const [recentsCollapsed, setRecentsCollapsed] = useState(false);

  const loadRepos = useCallback(() => {
    invoke<Array<{ name: string; display_name: string; path: string; has_readme: boolean }>>(
      "list_cloned_repos",
      { projectPath },
    )
      // A missing or failed answer means "no clones", not a crash on `.length`.
      .then((repos) => setClonedRepos(repos ?? []))
      .catch(() => setClonedRepos([]));
  }, [projectPath]);

  useEffect(() => {
    loadRepos();
  }, [loadRepos]);

  useEffect(() => {
    const handler = () => loadRepos();
    window.addEventListener("focus", handler);
    window.addEventListener("atlas:repo-cloned", handler);
    return () => {
      window.removeEventListener("focus", handler);
      window.removeEventListener("atlas:repo-cloned", handler);
    };
  }, [loadRepos]);

  const handleDeleteRepo = async (name: string) => {
    await invoke("delete_cloned_repo", { projectPath, repoName: name }).catch(() => {});
    logEvent({
      source: "github",
      kind: "repo-delete",
      summary: name,
      payload: { repoName: name },
    });
    loadRepos();
  };

  // Build the "Recently opened" list from the host-supplied stack of
  // recent entry ids, looking up titles from the current entries.
  // Dedupe defensively — `entries` may contain duplicate ids (an import
  // racing a manual save) and that's also a React-key risk.
  const recents = (() => {
    const out: Array<{ id: string; title: string }> = [];
    const seen = new Set<string>();
    for (const id of recentIds) {
      if (seen.has(id)) continue;
      const entry = entries.find((e) => e.id === id);
      if (!entry) continue;
      seen.add(id);
      out.push(entry);
      if (out.length >= 5) break;
    }
    return out;
  })();

  return (
    <aside
      className="flex flex-col min-h-0 shrink-0 border-r border-border-subtle"
      style={{ width, background: "var(--panel-background)" }}
    >
      {/* Header — matches the project file-tree's typography
          (10px / semibold / tracking-wider, UI font) so the two
          sidebars read as one consistent system. */}
      <HintGroup>
        <div className="flex items-center px-3 pt-3.5 pb-2 shrink-0">
          <span className="text-2xs font-semibold text-muted-foreground uppercase tracking-wider truncate flex-1">
            Knowledge
          </span>
          <HintItem label={treeExpandedCount > 0 ? "Collapse all" : "Expand all"}>
            <button
              onClick={() =>
                treeExpandedCount > 0
                  ? treeRef.current?.collapseAll()
                  : treeRef.current?.expandAll()
              }
              className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors cursor-pointer"
              style={{ width: 22, height: 22 }}
            >
              {treeExpandedCount > 0 ? <FoldVertical size={12} /> : <UnfoldVertical size={12} />}
            </button>
          </HintItem>
          <HintItem label="Open graph view">
            <button
              onClick={onOpenGraph}
              className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors cursor-pointer"
              style={{ width: 22, height: 22 }}
            >
              <Network size={12} />
            </button>
          </HintItem>
          <HintItem label="New folder">
            <button
              onClick={onNewFolder}
              className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors cursor-pointer"
              style={{ width: 22, height: 22 }}
            >
              <FolderPlus size={12} />
            </button>
          </HintItem>
          <HintItem label="New page">
            <button
              onClick={onNewNote}
              className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors cursor-pointer"
              style={{ width: 22, height: 22 }}
            >
              <FilePlus size={12} />
            </button>
          </HintItem>
          <DropdownMenu.Root>
            <HintItem label="Import notes / folder">
              <DropdownMenu.Trigger
                render={
                  <button
                    className="p-1 rounded text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors cursor-pointer outline-none"
                    style={{ width: 22, height: 22 }}
                  >
                    <Download size={12} />
                  </button>
                }
              />
            </HintItem>
            <DropdownMenu.Portal>
              <DropdownMenu.Positioner className="z-popover" align="end" sideOffset={4}>
                <DropdownMenu.Popup className="min-w-[180px] rounded-md border border-border bg-card py-1 shadow-md">
                  <DropdownMenu.Item
                    onClick={onImportFiles}
                    className="flex items-center gap-2 px-2.5 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-pointer outline-none"
                  >
                    <FileText size={13} /> Import .md files…
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    onClick={onImportFolder}
                    className="flex items-center gap-2 px-2.5 h-control-md text-xs text-secondary-foreground hover:bg-element-hover hover:text-foreground cursor-pointer outline-none"
                  >
                    <Folder size={13} /> Import folder…
                  </DropdownMenu.Item>
                </DropdownMenu.Popup>
              </DropdownMenu.Positioner>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </HintGroup>

      {/* Inline new-folder input — sits between the header and the
          tree so it doesn't overlay row content. Auto-closes on
          commit/cancel. */}
      {folderInputOpen && (
        <div className="px-2.5 pb-2 shrink-0">
          <input
            value={folderInputValue}
            autoFocus
            onChange={(e) => onFolderInputChange?.(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onFolderInputCommit?.();
              if (e.key === "Escape") onFolderInputCancel?.();
            }}
            onBlur={() => {
              if (!folderInputValue.trim()) onFolderInputCancel?.();
            }}
            placeholder="Folder name…"
            className="w-full bg-panel-input border border-border rounded text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-border-strong transition-colors"
            style={{ height: 26, padding: "0 8px" }}
          />
        </div>
      )}

      {/* Tree (scrollable middle) */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <KnowledgeTree
          ref={treeRef}
          entries={entries}
          activeEntryId={activeRepoName ? null : activeEntryId}
          onSelect={onSelectEntry}
          onDelete={onDeleteEntry}
          onExpandedCountChange={setTreeExpandedCount}
        />

        {/* Recently opened */}
        {recents.length > 0 && (
          <div className="px-1.5 pb-2 shrink-0">
            <div className="group flex items-center gap-1 px-2 pt-3 pb-1">
              <button
                onClick={() => setRecentsCollapsed((v) => !v)}
                className="flex items-center gap-1 text-2xs font-semibold text-muted-foreground uppercase tracking-wider hover:text-secondary-foreground transition-colors"
                title={recentsCollapsed ? "Expand" : "Collapse"}
              >
                {recentsCollapsed ? (
                  <ChevronRight size={11} className="shrink-0" />
                ) : (
                  <ChevronDown size={11} className="shrink-0" />
                )}
                Recently opened
              </button>
              <span className="flex-1" />
              <Hint label="Clear recently opened">
                <button
                  onClick={onClearRecents}
                  className="flex h-4 w-4 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-error transition-[color,opacity] cursor-pointer"
                >
                  <Trash2 size={11} />
                </button>
              </Hint>
            </div>
            {!recentsCollapsed && (
              <div className="flex flex-col gap-px max-h-[160px] overflow-y-auto hide-scrollbar">
                {recents.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => onSelectEntry(r.id)}
                    className="flex items-center gap-1.5 w-full px-2 py-1 rounded-md text-left text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground transition-colors text-sm"
                  >
                    <span className="truncate flex-1">{r.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Repositories — bottom section */}
      {clonedRepos.length > 0 && (
        <div className="border-t border-border-subtle shrink-0 py-2.5 px-1.5">
          <div className="px-2 pb-1.5 text-2xs font-semibold text-muted-foreground uppercase tracking-wider">
            Repositories
          </div>
          <div className="flex flex-col gap-px max-h-[208px] overflow-y-auto hide-scrollbar">
            {clonedRepos.map((repo) => {
              const isActive = activeRepoName === repo.name;
              return (
                <div
                  key={repo.name}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelectRepo(repo.name)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectRepo(repo.name);
                    }
                  }}
                  className={cn(
                    "group flex items-center gap-1.5 px-2 rounded-md cursor-pointer select-none transition-colors text-sm",
                    isActive
                      ? "text-foreground"
                      : "text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground",
                  )}
                  style={{
                    height: 26,
                    fontFamily: "var(--font-mono)",
                    background: isActive ? "var(--element-active)" : undefined,
                  }}
                  title={repo.path}
                >
                  <GitBranch
                    size={11}
                    className="text-muted-foreground shrink-0"
                    strokeWidth={1.5}
                  />
                  <span className="truncate flex-1 text-left">{repo.display_name}</span>
                  <Hint label="Remove repo">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteRepo(repo.name);
                      }}
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-0.5 rounded hover:text-error text-muted-foreground transition-opacity"
                    >
                      <Trash2 size={10} />
                    </button>
                  </Hint>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
