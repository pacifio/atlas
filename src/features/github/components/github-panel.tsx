import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "@/features/project/stores/project-store";
import { ScrollArea } from "@/ui/scroll-area";
import { Search, Star, GitFork, ExternalLink, Download, Loader2 } from "lucide-react";
import { GithubIcon } from "@/components/github-icon";
import { cn } from "@/lib/utils";
import { logEvent } from "@/features/log/lib/log";
import type { GithubRepo } from "@/features/github/types";

export function GithubPanel() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GithubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState<Set<string>>(new Set());
  const [cloned, setCloned] = useState<Set<string>>(new Set());
  const currentProject = useProjectStore.use.currentProject();

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const repos = await invoke<GithubRepo[]>("search_github", { query: query.trim() });
      setResults(repos);
    } catch (e) {
      setError(String(e));
      setResults([]);
    }
    setLoading(false);
  };

  const openInBrowser = async (url: string) => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch {
      window.open(url, "_blank");
    }
  };

  const cloneRepo = async (repo: GithubRepo) => {
    if (!currentProject || cloning.has(repo.full_name)) return;
    setCloning((s) => new Set(s).add(repo.full_name));
    try {
      const repoName = repo.full_name.replace("/", "-");
      await invoke("clone_github_repo", {
        projectPath: currentProject.path,
        cloneUrl: repo.clone_url,
        repoName,
      });
      setCloned((s) => new Set(s).add(repo.full_name));
      window.dispatchEvent(new Event("atlas:repo-cloned"));
      logEvent({
        source: "github",
        kind: "clone",
        summary: repo.full_name,
        payload: { repo: repo.full_name, clone_url: repo.clone_url },
      });
    } catch (e) {
      console.error("Clone failed:", e);
    }
    setCloning((s) => {
      const n = new Set(s);
      n.delete(repo.full_name);
      return n;
    });
  };

  return (
    <div className="h-full flex flex-col">
      {/* Search */}
      <div className="flex items-center gap-1.5 h-[32px] shrink-0 border-b border-border-default bg-bg-primary px-3">
        <Search size={11} className="text-text-tertiary shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          placeholder="Search GitHub repositories..."
          className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary"
        />
      </div>

      {/* Results */}
      <ScrollArea className="flex-1">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-accent" />
          </div>
        )}

        {error && (
          <div className="px-3 py-6 text-center">
            <p className="text-[11px] text-error">{error}</p>
            <button
              onClick={handleSearch}
              className="mt-1 text-[10px] text-accent hover:underline cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && results.length === 0 && !query.trim() && (
          <div className="px-3 py-8 text-center">
            <GithubIcon size={16} className="text-text-tertiary mx-auto mb-2" />
            <p className="text-[11px] text-text-tertiary">Search for repositories</p>
          </div>
        )}

        {!loading && !error && results.length === 0 && query.trim() && (
          <div className="px-3 py-6 text-center text-[11px] text-text-tertiary">
            No repositories found
          </div>
        )}

        {results.map((repo) => {
          const isCloning = cloning.has(repo.full_name);
          const isCloned = cloned.has(repo.full_name);
          return (
            <div
              key={repo.full_name}
              className="px-3 py-2.5 border-b border-border-default hover:bg-bg-hover group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium text-accent truncate">
                      {repo.full_name}
                    </span>
                  </div>
                  {repo.description && (
                    <p className="text-[10px] text-text-tertiary mt-0.5 line-clamp-2">
                      {repo.description}
                    </p>
                  )}
                  <div className="flex items-center gap-3 mt-1">
                    {repo.language && (
                      <span className="text-[9px] text-text-tertiary">{repo.language}</span>
                    )}
                    <span className="flex items-center gap-0.5 text-[9px] text-text-tertiary">
                      <Star size={8} /> {repo.stars.toLocaleString()}
                    </span>
                    <span className="flex items-center gap-0.5 text-[9px] text-text-tertiary">
                      <GitFork size={8} /> {repo.forks.toLocaleString()}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => openInBrowser(repo.html_url)}
                    className="p-1 rounded hover:bg-bg-active text-text-tertiary hover:text-text-primary cursor-pointer"
                    title="Open on GitHub"
                  >
                    <ExternalLink size={11} />
                  </button>
                  {currentProject && (
                    <button
                      onClick={() => cloneRepo(repo)}
                      disabled={isCloning || isCloned}
                      className={cn(
                        "p-1 rounded cursor-pointer",
                        isCloned
                          ? "text-success"
                          : isCloning
                            ? "text-accent"
                            : "text-text-tertiary hover:text-text-primary hover:bg-bg-active",
                      )}
                      title={
                        isCloned ? "Cloned" : isCloning ? "Cloning..." : "Clone to .atlas/repos/"
                      }
                    >
                      {isCloning ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Download size={11} />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </ScrollArea>
    </div>
  );
}
