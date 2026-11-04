// The session list's sections below the pinned and active rows: the search
// results, the Snoozed and Settled shelves, and the empty and error states.
// Props only; `sidebar-session-list.tsx` is the container, and it hands each
// section a `renderRow` so the rows stay its memoised containers.

import type { ReactNode } from "react";
import { Plus, Search, X } from "lucide-react";
import type { SidebarSession } from "../../lib/sidebar-sessions";
import { CollapsibleSectionHeader } from "../sidebar-section-header";
import { SEARCH_RESULTS_ID } from "../sidebar-session-header";

type RenderRow = (session: SidebarSession) => ReactNode;

export function SessionSearchResultsView({
  query,
  results,
  renderResult,
}: {
  query: string;
  results: readonly SidebarSession[];
  renderResult: (session: SidebarSession, index: number) => ReactNode;
}) {
  if (results.length === 0) {
    return (
      <div className="px-2 py-6 text-center text-xs text-muted-foreground">
        No sessions match “{query.trim()}”.
      </div>
    );
  }
  return (
    <ul id={SEARCH_RESULTS_ID} role="listbox" aria-label="Search results" className="flex flex-col">
      {results.map(renderResult)}
    </ul>
  );
}

export function SnoozedShelfView({
  count,
  expanded,
  onToggle,
  rows,
  renderRow,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  rows: readonly SidebarSession[];
  renderRow: RenderRow;
}) {
  return (
    <div className="mt-2">
      <CollapsibleSectionHeader
        expanded={expanded}
        tone="info"
        onClick={onToggle}
        data-testid="sidebar-snoozed-shelf-toggle"
      >
        {expanded ? "Snoozed" : `Snoozed (${count})`}
      </CollapsibleSectionHeader>
      <ul aria-label="Snoozed sessions" className="flex flex-col">
        {rows.map(renderRow)}
      </ul>
    </div>
  );
}

export function SettledShelfView({
  count,
  expanded,
  onToggle,
  search,
  onSearchChange,
  rows,
  renderRow,
  noMatches,
  hiddenCount,
  pageSize,
  onShowMore,
}: {
  count: number;
  expanded: boolean;
  onToggle: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  rows: readonly SidebarSession[];
  renderRow: RenderRow;
  noMatches: boolean;
  /** Rows past the shelf's current page; `0` hides "Show more". */
  hiddenCount: number;
  pageSize: number;
  onShowMore: () => void;
}) {
  return (
    <div className="mt-2">
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={onToggle}
        data-testid="sidebar-settled-shelf-toggle"
      >
        {expanded ? "Settled" : `Settled (${count})`}
      </CollapsibleSectionHeader>
      {expanded ? (
        <label className="mx-0.5 mb-1 flex h-7 cursor-text items-center gap-2 rounded-md px-2 text-muted-foreground hover:bg-element-hover focus-within:bg-element-hover">
          <Search aria-hidden className="size-3 shrink-0" />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.preventDefault();
                event.stopPropagation();
                onSearchChange("");
              }
            }}
            placeholder="Search settled"
            aria-label="Search settled sessions"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
          {search ? (
            <button
              type="button"
              aria-label="Clear settled search"
              onClick={() => onSearchChange("")}
              className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm hover:text-foreground"
            >
              <X aria-hidden className="size-3" />
            </button>
          ) : null}
        </label>
      ) : null}
      <ul aria-label="Settled sessions" className="flex flex-col">
        {rows.map(renderRow)}
        {noMatches ? (
          <li className="list-none px-2.5 py-2 text-xs text-muted-foreground">
            No settled sessions match.
          </li>
        ) : null}
        {hiddenCount > 0 ? (
          <li className="list-none">
            <button
              type="button"
              onClick={onShowMore}
              className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-muted-foreground hover:bg-element-hover hover:text-foreground"
            >
              <Plus aria-hidden className="size-4 shrink-0" />
              Show {Math.min(hiddenCount, pageSize)} more
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function SessionListErrorView({ error }: { error: string }) {
  return (
    <div className="px-2 py-6 text-center text-xs text-error">
      Couldn't read session history: {error}
    </div>
  );
}

/** No sessions at all: offer the first step — a project, or an import. */
export function SessionListEmptyView({
  hasProjects,
  scopedProjectName,
  onAddProject,
  onImportSessions,
}: {
  hasProjects: boolean;
  /** The project filter's project, when the list is filtered to one. */
  scopedProjectName: string | null;
  onAddProject: () => void;
  onImportSessions: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground">
      {!hasProjects ? (
        <>
          <span>No projects yet</span>
          <button
            type="button"
            onClick={onAddProject}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-2xs font-medium text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
          >
            <Plus aria-hidden className="-mx-0.5 size-3" />
            Add project
          </button>
        </>
      ) : scopedProjectName !== null ? (
        `No sessions in ${scopedProjectName} yet`
      ) : (
        <>
          <span>No sessions yet</span>
          <button
            type="button"
            onClick={onImportSessions}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-2xs font-medium text-secondary-foreground transition-colors hover:bg-element-hover hover:text-foreground"
          >
            Import sessions from agents…
          </button>
        </>
      )}
    </div>
  );
}
