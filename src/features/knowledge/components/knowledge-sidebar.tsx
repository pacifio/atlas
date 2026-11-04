import { useCallback, useEffect, useRef, useState } from "react";
import { logEvent } from "@/features/log/lib/log";
import { KnowledgeTree, type KnowledgeTreeHandle } from "./knowledge-tree";
import { KnowledgeSidebarView } from "./views/knowledge-sidebar-view";
import { deleteClonedRepo, listClonedRepos, type KnowledgeClonedRepo } from "../lib/knowledge-api";

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
  const [clonedRepos, setClonedRepos] = useState<KnowledgeClonedRepo[]>([]);

  // Imperative handle on the KnowledgeTree so the header can drive
  // collapse-all / expand-all without lifting the tree's expanded set
  // into the sidebar (matches the explorer's collapseAll pattern).
  const treeRef = useRef<KnowledgeTreeHandle>(null);
  const [treeExpandedCount, setTreeExpandedCount] = useState(0);

  const loadRepos = useCallback(() => {
    listClonedRepos(projectPath)
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
    await deleteClonedRepo(projectPath, name).catch(() => {});
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
    <KnowledgeSidebarView
      width={width}
      tree={
        <KnowledgeTree
          ref={treeRef}
          entries={entries}
          activeEntryId={activeRepoName ? null : activeEntryId}
          onSelect={onSelectEntry}
          onDelete={onDeleteEntry}
          onExpandedCountChange={setTreeExpandedCount}
        />
      }
      anyExpanded={treeExpandedCount > 0}
      onToggleAll={() =>
        treeExpandedCount > 0 ? treeRef.current?.collapseAll() : treeRef.current?.expandAll()
      }
      onOpenGraph={onOpenGraph}
      onNewFolder={onNewFolder}
      onNewNote={onNewNote}
      onImportFiles={onImportFiles}
      onImportFolder={onImportFolder}
      folderInput={
        folderInputOpen
          ? {
              value: folderInputValue,
              onChange: (v) => onFolderInputChange?.(v),
              onCommit: () => onFolderInputCommit?.(),
              onCancel: () => onFolderInputCancel?.(),
            }
          : null
      }
      recents={recents}
      onOpenPage={onSelectEntry}
      onClearRecents={onClearRecents}
      repos={clonedRepos.map((r) => ({ name: r.name, displayName: r.display_name, path: r.path }))}
      activeRepoName={activeRepoName}
      onSelectRepo={onSelectRepo}
      onDeleteRepo={(name) => void handleDeleteRepo(name)}
    />
  );
}
