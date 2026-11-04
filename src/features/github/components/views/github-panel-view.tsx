import { useRef } from "react";
import { Search } from "lucide-react";
import {
  Button,
  Callout,
  EmptyState,
  Icon,
  ScrollFade,
  Spinner,
  useScrollEdges,
} from "@tryatlas/design";
import { GithubIcon } from "@/components/brand-marks";
import type { ClonedRepo, GithubRepo } from "../../types";
import { ClonedRepoRowView, type RowBusy } from "./cloned-repo-row-view";
import { SearchResultRowView, type CloneState } from "./search-result-row-view";

export interface GithubPanelViewProps {
  query: string;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  /** No project open: nothing to clone into, and no clones to list. */
  hasProject: boolean;
  /** Where clones land, for the clone button's label (`.atlas/repos/`). */
  cloneDir: string;
  clones: ClonedRepo[];
  rowBusy: Record<string, RowBusy>;
  /** A search is in flight; the previous results stay listed under it. */
  loading: boolean;
  /** The last search's failure, shown with a Retry. */
  error: string | null;
  results: GithubRepo[];
  /** Per search hit (`full_name`); a missing entry is `"idle"`. */
  cloneStates: Record<string, Exclude<CloneState, null>>;
  loadBranches: (repo: ClonedRepo) => Promise<string[]>;
  onSwitchBranch: (repo: ClonedRepo, branch: string) => void;
  onUpdate: (repo: ClonedRepo) => void;
  onDelete: (repo: ClonedRepo) => void;
  onOpenUrl: (url: string) => void;
  onClone: (repo: GithubRepo) => void;
}

/** The scroll fades' gradient. The right panel paints `--card`, so the fade
 *  runs from the card, not the background. */
const FADE = "from-card via-card/80";

/**
 * The GitHub panel: search public repositories, clone them as reference
 * material under `<project>/.atlas/repos/`, and manage what is already there.
 * The cloned list is the resting state; a typed query replaces it with the
 * search's results until the box is cleared.
 */
export function GithubPanelView({
  query,
  onQueryChange,
  onSearch,
  hasProject,
  cloneDir,
  clones,
  rowBusy,
  loading,
  error,
  results,
  cloneStates,
  loadBranches,
  onSwitchBranch,
  onUpdate,
  onDelete,
  onOpenUrl,
  onClone,
}: GithubPanelViewProps) {
  const searching = query.trim().length > 0;
  const scrollRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(scrollRef, [clones.length, results.length, searching, loading]);

  return (
    <div data-view="github-panel" className="flex h-full flex-col">
      {/* A bare search strip on the panel's own surface, like the source
          control filter rows: no field border, so not an `InputGroup`. */}
      <div className="flex h-control-lg shrink-0 items-center gap-1.5 border-b border-border-subtle px-3">
        <Icon icon={Search} size="sm" className="text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSearch();
          }}
          placeholder="Search GitHub repositories..."
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>

      <div className="relative min-h-0 flex-1">
        <ScrollFade className={FADE} at="top" visible={edges.top} />
        <ScrollFade className={FADE} at="bottom" visible={edges.bottom} />
        <div ref={scrollRef} className="h-full overflow-y-auto hide-scrollbar">
          {!searching &&
            hasProject &&
            clones.map((repo) => (
              <ClonedRepoRowView
                key={repo.name}
                repo={repo}
                busy={rowBusy[repo.name] ?? null}
                loadBranches={() => loadBranches(repo)}
                onSwitch={(branch) => onSwitchBranch(repo, branch)}
                onUpdate={() => onUpdate(repo)}
                onOpen={() =>
                  onOpenUrl(repo.meta?.html_url || `https://github.com/${repo.display_name}`)
                }
                onDelete={() => onDelete(repo)}
              />
            ))}

          {loading && (
            <div className="flex items-center justify-center py-8">
              <Spinner size="lg" />
            </div>
          )}

          {error && (
            <div className="p-3">
              <Callout
                tone="error"
                action={
                  <Button variant="ghost" size="xs" onClick={onSearch}>
                    Retry
                  </Button>
                }
              >
                {error}
              </Callout>
            </div>
          )}

          {!loading && !error && results.length === 0 && !searching && clones.length === 0 && (
            <EmptyState icon={GithubIcon} title="Search for repositories" />
          )}

          {!loading && !error && results.length === 0 && searching && (
            <EmptyState title="No repositories found" />
          )}

          {results.map((repo) => (
            <SearchResultRowView
              key={repo.full_name}
              repo={repo}
              cloneDir={cloneDir}
              cloneState={hasProject ? (cloneStates[repo.full_name] ?? "idle") : null}
              onOpen={() => onOpenUrl(repo.html_url)}
              onClone={() => onClone(repo)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
