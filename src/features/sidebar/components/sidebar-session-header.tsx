// The list's header: search across every session, and new session. Which
// projects the list shows is the project picker above it (`project-picker.tsx`).
//
// The search is a combobox over the list below it: typing swaps the sections
// for results, the arrow keys move a highlight through them (the field keeps
// focus), Enter opens the highlighted one and Escape clears.

import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { Search, SquarePen, X } from "lucide-react";
import { Hint } from "@/ui/tooltip";

export const SEARCH_RESULTS_ID = "sidebar-session-search-results";
export const searchResultId = (index: number) => `sidebar-session-search-result-${index}`;

export interface SidebarSessionHeaderProps {
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
  onNewSession: () => void;
  newSessionDisabled: boolean;
  newSessionShortcut: string | null;
}

export function SidebarSessionHeader(props: SidebarSessionHeaderProps) {
  const {
    searchInputRef,
    searchQuery,
    onSearchQueryChange,
    onSearchKeyDown,
    isSearching,
    searchResultCount,
    activeSearchResultIndex,
    onClearSearch,
  } = props;
  const resultsVisible = isSearching && searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  return (
    <div className="flex items-center gap-1 px-2">
      <label className="flex h-7 min-w-0 flex-1 cursor-text items-center gap-2 rounded-md px-2 text-sm text-muted-foreground hover:bg-element-hover hover:text-foreground focus-within:bg-element-hover">
        <Search aria-hidden className="size-3.5 shrink-0" />
        <input
          ref={searchInputRef}
          type="search"
          value={searchQuery}
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Search sessions"
          aria-label="Search sessions"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={resultsVisible}
          aria-controls={resultsVisible ? SEARCH_RESULTS_ID : undefined}
          aria-activedescendant={
            activeResultExists ? searchResultId(activeSearchResultIndex) : undefined
          }
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
        {isSearching ? (
          <button
            type="button"
            aria-label="Clear session search"
            onClick={() => {
              onClearSearch();
              searchInputRef.current?.focus();
            }}
            className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          >
            <X aria-hidden className="size-3" />
          </button>
        ) : null}
      </label>
      <div className="flex shrink-0 items-center">
        <HeaderIconButton
          label={
            props.newSessionShortcut ? `New session ${props.newSessionShortcut}` : "New session"
          }
          disabled={props.newSessionDisabled}
          onClick={props.onNewSession}
        >
          <SquarePen aria-hidden className="size-3.5" />
        </HeaderIconButton>
      </div>
    </div>
  );
}

function HeaderIconButton({
  label,
  children,
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Hint label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-element-hover hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        {children}
      </button>
    </Hint>
  );
}
