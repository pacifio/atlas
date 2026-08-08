import { useState, useEffect, useRef } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { useExplorerStore } from "@/features/explorer/stores/explorer-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useSessionStore } from "@/features/project/stores/session-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { Search, FileCode, Clock, X } from "lucide-react";

interface SearchResult {
  file_path: string;
  line: number;
  content: string;
  match_start: number;
  match_end: number;
}

export function SearchOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootPath = useExplorerStore.use.rootPath();
  const { addTab } = useLayoutStore.use.actions();
  const session = useSessionStore.use.session();
  const { addSearchHistory, removeSearchHistory, clearSearchHistory, saveSession } =
    useSessionStore.use.actions();
  const currentProject = useProjectStore.use.currentProject();

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSelectedIndex(0);
      setHasSearched(false);
    }
  }, [open]);

  const performSearch = async (searchQuery: string) => {
    if (!searchQuery.trim() || !rootPath) return;
    setSearching(true);
    setHasSearched(true);
    try {
      const res = await invoke<SearchResult[]>("search_in_files", {
        path: rootPath,
        query: searchQuery.trim(),
        maxResults: 50,
      });
      setResults(res);
      setSelectedIndex(0);
      addSearchHistory(searchQuery.trim());
      if (currentProject) saveSession(currentProject.path);
    } catch {
      setResults([]);
    }
    setSearching(false);
  };

  const openResult = (result: SearchResult) => {
    const fullPath = rootPath ? `${rootPath}/${result.file_path}` : result.file_path;
    addTab({
      id: `editor-${fullPath}`,
      type: "editor",
      title: result.file_path.split("/").pop() ?? "file",
      closable: true,
      dirty: false,
      data: { filePath: fullPath },
    });
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results.length > 0 && results[selectedIndex]) {
        openResult(results[selectedIndex]);
      } else {
        performSearch(query);
      }
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60" style={{ zIndex: 99998 }} />
        <Dialog.Content
          className={cn(
            "fixed top-[15%] left-1/2 -translate-x-1/2",
            "w-[600px] max-h-[500px] rounded-xl overflow-hidden",
            "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
            "shadow-[var(--shadow-overlay)]",
            "flex flex-col",
          )}
          style={{ zIndex: 99999 }}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <div className="flex items-center gap-2 px-4 h-[44px] shrink-0 border-b border-[var(--border-default)]">
            <Search size={14} className="text-[var(--text-tertiary)] shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search in files..."
              className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
            {searching && (
              <span className="text-[10px] text-[var(--text-tertiary)]">Searching...</span>
            )}
          </div>

          <div className="overflow-y-auto flex-1 py-1">
            {results.length === 0 && hasSearched && !searching && (
              <div className="px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
                No results found
              </div>
            )}
            {!query.trim() && !hasSearched && session.searchHistory.length > 0 && (
              <div className="py-1">
                <div className="flex items-center justify-between px-4 py-1">
                  <span className="text-[10px] text-[var(--text-tertiary)] uppercase tracking-wide font-semibold">
                    Recent searches
                  </span>
                  <button
                    onClick={() => {
                      clearSearchHistory();
                      if (currentProject) saveSession(currentProject.path);
                    }}
                    className="text-[9px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] cursor-pointer"
                  >
                    Clear all
                  </button>
                </div>
                {session.searchHistory.slice(0, 8).map((q, i) => (
                  <div
                    key={`${q}-${i}`}
                    className="flex items-center px-4 py-1.5 hover:bg-[var(--bg-hover)] group"
                  >
                    <button
                      onClick={() => {
                        setQuery(q);
                        performSearch(q);
                      }}
                      className="flex items-center gap-2 flex-1 min-w-0 text-left"
                    >
                      <Clock size={11} className="text-[var(--text-tertiary)] shrink-0" />
                      <span className="text-[11px] text-[var(--text-secondary)] font-mono truncate">
                        {q}
                      </span>
                    </button>
                    <button
                      onClick={() => {
                        removeSearchHistory(q);
                        if (currentProject) saveSession(currentProject.path);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] shrink-0"
                    >
                      <X size={9} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {!query.trim() && !hasSearched && session.searchHistory.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
                Type to search across all files
              </div>
            )}
            {results.map((result, i) => (
              <button
                key={`${result.file_path}:${result.line}:${i}`}
                onClick={() => openResult(result)}
                onMouseEnter={() => setSelectedIndex(i)}
                className={cn(
                  "w-full text-left px-4 py-1.5 transition-colors",
                  i === selectedIndex ? "bg-[var(--bg-hover)]" : "",
                )}
              >
                <div className="flex items-center gap-2">
                  <FileCode size={12} className="text-[var(--text-tertiary)] shrink-0" />
                  <span className="text-[11px] text-[var(--accent-primary)] font-mono truncate">
                    {result.file_path}
                  </span>
                  <span className="text-[10px] text-[var(--text-tertiary)] font-mono shrink-0">
                    :{result.line}
                  </span>
                </div>
                <div className="ml-5 text-[11px] font-mono text-[var(--text-secondary)] truncate mt-0.5">
                  {result.content.trim()}
                </div>
              </button>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
