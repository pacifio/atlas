import { useState, type ReactNode } from "react";
import {
  ChevronRight,
  Download,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  FoldVertical,
  GitBranch,
  Network,
  Trash2,
  UnfoldVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Hint,
  HintGroup,
  HintItem,
  Icon,
  IconButton,
  Input,
} from "@tryatlas/design";
import { cn } from "@/lib/utils";

export interface SidebarFolderInput {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export interface SidebarRepo {
  name: string;
  displayName: string;
  path: string;
}

/**
 * The Knowledge sidebar: the header's actions, the inline new-folder field,
 * the page tree (the `tree` slot), "Recently opened" and the cloned
 * repositories. Everything it shows and does comes in through props.
 */
export function KnowledgeSidebarView({
  width,
  tree,
  anyExpanded,
  onToggleAll,
  onOpenGraph,
  onNewFolder,
  onNewNote,
  onImportFiles,
  onImportFolder,
  folderInput,
  recents,
  onOpenPage,
  onClearRecents,
  repos,
  activeRepoName,
  onSelectRepo,
  onDeleteRepo,
}: {
  width: number;
  tree: ReactNode;
  anyExpanded: boolean;
  onToggleAll: () => void;
  onOpenGraph: () => void;
  onNewFolder: () => void;
  onNewNote: () => void;
  onImportFiles: () => void;
  onImportFolder: () => void;
  folderInput: SidebarFolderInput | null;
  recents: ReadonlyArray<{ id: string; title: string }>;
  onOpenPage: (id: string) => void;
  onClearRecents: () => void;
  repos: readonly SidebarRepo[];
  activeRepoName: string | null;
  onSelectRepo: (name: string) => void;
  onDeleteRepo: (name: string) => void;
}) {
  const [recentsOpen, setRecentsOpen] = useState(true);

  return (
    <aside
      data-view="knowledge-sidebar"
      className="flex min-h-0 shrink-0 flex-col border-r border-border-subtle bg-panel"
      style={{ width }}
    >
      <HintGroup>
        <div className="flex shrink-0 items-center gap-0.5 px-3 pt-3.5 pb-2">
          <span className="eyebrow flex-1 truncate">Knowledge</span>
          <HintItem label={anyExpanded ? "Collapse all" : "Expand all"}>
            <IconButton
              size="xs"
              icon={anyExpanded ? FoldVertical : UnfoldVertical}
              label={anyExpanded ? "Collapse all" : "Expand all"}
              onClick={onToggleAll}
            />
          </HintItem>
          <HintItem label="Open graph view">
            <IconButton size="xs" icon={Network} label="Open graph view" onClick={onOpenGraph} />
          </HintItem>
          <HintItem label="New folder">
            <IconButton size="xs" icon={FolderPlus} label="New folder" onClick={onNewFolder} />
          </HintItem>
          <HintItem label="New page">
            <IconButton size="xs" icon={FilePlus} label="New page" onClick={onNewNote} />
          </HintItem>
          <DropdownMenu>
            <HintItem label="Import notes / folder">
              <DropdownMenuTrigger
                render={<IconButton size="xs" icon={Download} label="Import notes / folder" />}
              />
            </HintItem>
            <DropdownMenuContent align="end" sideOffset={4} className="min-w-[180px]">
              <DropdownMenuItem onClick={onImportFiles}>
                <Icon icon={FileText} size="md" /> Import .md files…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onImportFolder}>
                <Icon icon={Folder} size="md" /> Import folder…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </HintGroup>

      {/* Inline new-folder input — sits between the header and the tree so
          it doesn't overlay row content. Closes on commit/cancel. */}
      {folderInput && (
        <div className="shrink-0 px-2.5 pb-2">
          <Input
            size="md"
            value={folderInput.value}
            autoFocus
            aria-label="New folder name"
            onChange={(e) => folderInput.onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") folderInput.onCommit();
              if (e.key === "Escape") folderInput.onCancel();
            }}
            onBlur={() => {
              if (!folderInput.value.trim()) folderInput.onCancel();
            }}
            placeholder="Folder name…"
          />
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tree}

        {recents.length > 0 && (
          <div className="shrink-0 px-1.5 pb-2">
            <div className="group flex items-center gap-1 px-2 pt-3 pb-1">
              <button
                type="button"
                aria-expanded={recentsOpen}
                onClick={() => setRecentsOpen((v) => !v)}
                title={recentsOpen ? "Collapse" : "Expand"}
                className="eyebrow flex items-center gap-1 transition-colors duration-fast hover:text-secondary-foreground"
              >
                <Icon
                  icon={ChevronRight}
                  size="sm"
                  className={cn(
                    "shrink-0 transition-transform duration-fast",
                    recentsOpen && "rotate-90",
                  )}
                />
                Recently opened
              </button>
              <span className="flex-1" />
              <span className="opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-within:opacity-100">
                <Hint label="Clear recently opened">
                  <IconButton
                    size="xs"
                    variant="ghost-destructive"
                    icon={Trash2}
                    label="Clear recently opened"
                    onClick={onClearRecents}
                  />
                </Hint>
              </span>
            </div>
            {recentsOpen && (
              <div className="hide-scrollbar flex max-h-[160px] flex-col gap-px overflow-y-auto">
                {recents.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onOpenPage(r.id)}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-muted-foreground transition-colors duration-fast hover:bg-element-hover hover:text-secondary-foreground"
                  >
                    <span className="flex-1 truncate">{r.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {repos.length > 0 && (
        <div className="shrink-0 border-t border-border-subtle px-1.5 py-2.5">
          <div className="eyebrow px-2 pb-1.5">Repositories</div>
          <div className="hide-scrollbar flex max-h-[208px] flex-col gap-px overflow-y-auto">
            {repos.map((repo) => {
              const isActive = activeRepoName === repo.name;
              return (
                <div key={repo.name} className="group relative flex items-center">
                  {/* Two sibling buttons, not a button inside a button. */}
                  <button
                    type="button"
                    onClick={() => onSelectRepo(repo.name)}
                    title={repo.path}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      "flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 pr-7 font-mono text-sm transition-colors duration-fast select-none",
                      isActive
                        ? "bg-element-active text-foreground"
                        : "text-muted-foreground hover:bg-element-hover hover:text-secondary-foreground",
                    )}
                  >
                    <Icon icon={GitBranch} size="sm" className="shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-left">{repo.displayName}</span>
                  </button>
                  <span className="absolute right-1 flex opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-within:opacity-100">
                    <Hint label="Remove repo">
                      <IconButton
                        size="xs"
                        variant="ghost-destructive"
                        icon={Trash2}
                        label="Remove repo"
                        onClick={() => onDeleteRepo(repo.name)}
                      />
                    </Hint>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
