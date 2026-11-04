import { useState, useEffect, useId, useRef, type KeyboardEvent } from "react";
import { openFile } from "@/lib/open-file";
import { useSessionStore } from "@/features/app/stores/session-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { FileCode, Clock, X } from "lucide-react";
import { codeGrep, type CodeGrepMatch, type CodeSearchOptions } from "@/components/code-search-api";
import {
  Button,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandPanel,
  Hint,
  Icon,
  IconButton,
  Toggle,
} from "@tryatlas/design";

/** The switches beside the query, in VS Code's order and with its glyphs. */
const TOGGLES: { key: keyof CodeSearchOptions; glyph: string; label: string }[] = [
  { key: "caseSensitive", glyph: "Aa", label: "Match case" },
  { key: "wholeWord", glyph: "ab", label: "Match whole word" },
  { key: "regex", glyph: ".*", label: "Use regular expression" },
];

export function SearchOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodeGrepMatch[]>([]);
  const [options, setOptions] = useState<CodeSearchOptions>({
    regex: false,
    caseSensitive: false,
    wholeWord: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  // Bumped by every search (and by closing): a response from an older one is
  // dropped, so a slow search never overwrites a newer one's results.
  const searchSeq = useRef(0);
  // The query the shown results answer.
  const searchedQuery = useRef("");
  const session = useSessionStore.use.session();
  const { addSearchHistory, removeSearchHistory, clearSearchHistory, saveSession } =
    useSessionStore.use.actions();
  const currentProject = useAppStore.use.currentProject();
  const rootPath = currentProject?.path ?? null;

  useEffect(() => {
    if (!open) {
      searchSeq.current += 1;
      setSearching(false);
      setQuery("");
      setResults([]);
      setError(null);
      setTruncated(false);
      setSelectedIndex(0);
      setHasSearched(false);
    }
  }, [open]);

  const performSearch = async (searchQuery: string, opts: CodeSearchOptions = options) => {
    if (!searchQuery.trim() || !rootPath) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    setHasSearched(true);
    searchedQuery.current = searchQuery.trim();
    try {
      const res = await codeGrep(rootPath, searchQuery.trim(), opts);
      if (seq !== searchSeq.current) return;
      setResults(res.matches);
      setTruncated(res.truncated);
      setError(null);
      setSelectedIndex(0);
      addSearchHistory(searchQuery.trim());
      if (currentProject) saveSession(currentProject.path);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setResults([]);
      setTruncated(false);
      setError(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setSearching(false);
  };

  const toggle = (key: keyof CodeSearchOptions) => {
    const next = { ...options, [key]: !options[key] };
    setOptions(next);
    inputRef.current?.focus();
    if (hasSearched) void performSearch(query, next);
  };

  const openResult = (result: CodeGrepMatch) => {
    const fullPath = rootPath ? `${rootPath}/${result.path}` : result.path;
    // Close first: the dialog hands focus back as it closes, which would
    // otherwise land on the old control after the file's tab took it.
    onOpenChange(false);
    void openFile(fullPath, { reveal: { line: result.line } });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // An IME's Enter commits the composition; it is not a search.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // The results answer the query that was searched; once it has been
      // edited, Enter searches the new one rather than opening an old hit.
      const edited = query.trim() !== searchedQuery.current;
      if (!edited && results.length > 0 && results[selectedIndex]) {
        openResult(results[selectedIndex]);
      } else {
        void performSearch(query);
      }
    }
  };

  const activeId = results[selectedIndex] ? `${listId}-${selectedIndex}` : undefined;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup
        title="Search in files"
        // Base UI's initialFocus replaces Radix's onOpenAutoFocus +
        // preventDefault + focus(): hand it the element to land on.
        initialFocus={inputRef}
      >
        <CommandInput
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search in files..."
          // The listbox only exists while there are results.
          aria-controls={results.length > 0 ? listId : undefined}
          aria-expanded={results.length > 0}
          aria-activedescendant={activeId}
          endAddon={
            <div className="flex shrink-0 items-center gap-0.5">
              {searching && (
                <span className="me-1.5 text-xs text-muted-foreground">Searching...</span>
              )}
              {TOGGLES.map(({ key, glyph, label }) => (
                <Hint key={key} label={label}>
                  <Toggle
                    size="sm"
                    aria-label={label}
                    pressed={options[key]}
                    onPressedChange={() => toggle(key)}
                    className="font-mono"
                  >
                    {glyph}
                  </Toggle>
                </Hint>
              ))}
            </div>
          }
        />

        {error && !searching && <CommandEmpty>{error}</CommandEmpty>}
        {results.length === 0 && hasSearched && !searching && !error && (
          <CommandEmpty>No results found</CommandEmpty>
        )}
        {!query.trim() && !hasSearched && session.searchHistory.length > 0 && (
          <div className="min-h-0 overflow-y-auto px-2 pb-2">
            <div className="flex items-center justify-between pe-1">
              <CommandGroupLabel>Recent searches</CommandGroupLabel>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  clearSearchHistory();
                  if (currentProject) saveSession(currentProject.path);
                }}
              >
                Clear all
              </Button>
            </div>
            {session.searchHistory.slice(0, 8).map((q, i) => (
              <div
                key={`${q}-${i}`}
                className="group flex items-center rounded-lg pe-1.5 hover:bg-element-hover"
              >
                <button
                  type="button"
                  onClick={() => {
                    setQuery(q);
                    performSearch(q);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 px-2.5 py-1.5 text-left"
                >
                  <Icon icon={Clock} size="sm" className="text-muted-foreground" />
                  <span className="truncate font-mono text-sm text-secondary-foreground">{q}</span>
                </button>
                {/* Shown on row hover, or while the button has keyboard focus. */}
                <span className="flex opacity-0 group-hover:opacity-100 has-focus-visible:opacity-100">
                  <Hint label="Remove from history">
                    <IconButton
                      variant="ghost"
                      size="xs"
                      icon={X}
                      iconSize="xs"
                      label="Remove from history"
                      onClick={() => {
                        removeSearchHistory(q);
                        if (currentProject) saveSession(currentProject.path);
                      }}
                    />
                  </Hint>
                </span>
              </div>
            ))}
          </div>
        )}
        {!query.trim() && !hasSearched && session.searchHistory.length === 0 && (
          <CommandEmpty>Type to search across all files</CommandEmpty>
        )}
        {results.length > 0 && (
          <CommandPanel id={listId}>
            {results.map((result, i) => (
              <CommandItem
                key={`${result.path}:${result.line}:${i}`}
                id={`${listId}-${i}`}
                active={i === selectedIndex}
                // Rows stay Tab stops that Enter and Space open, as the
                // buttons they replace were.
                tabIndex={0}
                onClick={() => openResult(result)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  openResult(result);
                }}
                onMouseEnter={() => setSelectedIndex(i)}
              >
                <CommandItemIcon>
                  <Icon icon={FileCode} size="sm" />
                </CommandItemIcon>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 font-mono">
                  <span className="flex min-w-0 items-baseline gap-1.5">
                    <span className="truncate text-sm text-primary">{result.path}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">:{result.line}</span>
                  </span>
                  <span className="truncate text-sm text-secondary-foreground">
                    {result.text.trim()}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandPanel>
        )}
        {truncated && results.length > 0 && !searching && (
          <p className="px-5 pb-3 text-xs text-muted-foreground">
            Showing the first {results.length} matches. Narrow the search to see the rest.
          </p>
        )}
      </CommandDialogPopup>
    </CommandDialog>
  );
}
