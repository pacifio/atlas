import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Popover } from "@base-ui/react/popover";
import { GitBranch, Check, Plus, Search, Trash2, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStore, type BranchInfo } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { inProgressLabel } from "../../lib/in-progress";
import { Badge, Button, Callout, IconButton, Input, HintGroup, HintItem } from "@tryatlas/design";

/** Branch switcher popover: filter, checkout, create, delete, merge-into-current.
 *  The filter is a combobox over the list: ↑/↓ move (wrapping), Enter picks. */
export function BranchSwitcher() {
  const branch = useGitStore.use.branch();
  const detached = useGitStore.use.detached();
  const branchesFull = useGitStore.use.branchesFull();
  // A merge, rebase, cherry-pick or revert under way: checking out or merging
  // now would tangle it, so the list only shows where things stand.
  const busy = inProgressLabel(useGitStore.use.inProgress());
  const actions = useGitStore.use.actions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return branchesFull.filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [branchesFull, query]);

  // A new filter starts at the top; a list that shrank under the cursor
  // clamps it to the last row.
  useEffect(() => setActive(0), [query]);
  const activeIndex = Math.min(active, Math.max(0, filtered.length - 1));
  const optionId = (i: number) => `${listId}-option-${i}`;

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      handleGitError(e);
    }
  };

  const pick = (b: BranchInfo) => {
    if (busy) return;
    if (b.isCurrent) {
      setOpen(false);
      return;
    }
    // Remote-tracking refs (origin/foo) must be checked out by their
    // short name so git creates a local tracking branch instead of
    // landing in detached HEAD.
    const target = b.isRemote ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
    void run(() => actions.checkout(target));
    setOpen(false);
  };

  const onFilterKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || filtered.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const b = filtered[activeIndex];
      if (b) pick(b);
    }
  };

  const base = detached ? "HEAD" : branch;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQuery("");
          setCreating(false);
          setNewName("");
          setActive(0);
        }
      }}
    >
      <Popover.Trigger
        render={
          <Button variant="ghost" size="sm" className="min-w-0 shrink" title="Switch branch">
            <GitBranch size={12} />
            {detached ? (
              <span className="truncate text-warning">detached HEAD</span>
            ) : (
              <span className="truncate">{branch || "—"}</span>
            )}
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="start" sideOffset={4}>
          <Popover.Popup className="w-[260px] overflow-hidden rounded-lg border border-border bg-card shadow-md inset-highlight flex flex-col">
            <div className="flex items-center gap-1.5 px-2.5 h-control-lg border-b border-border-subtle shrink-0">
              <Search size={12} className="text-muted-foreground shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onFilterKeyDown}
                placeholder="Filter branches…"
                autoFocus
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={filtered.length > 0 ? optionId(activeIndex) : undefined}
                className="flex-1 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground min-w-0"
              />
            </div>

            {(detached || busy) && (
              <div className="shrink-0 px-2 pt-2">
                <Callout tone="warning" icon={false}>
                  {busy
                    ? `A ${busy} is in progress. Finish or abort it before switching branches.`
                    : "HEAD is detached. Commits made here belong to no branch — create a branch to keep them."}
                </Callout>
              </div>
            )}

            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Branches"
              className="max-h-[280px] overflow-y-auto hide-scrollbar p-1"
            >
              {filtered.map((b, i) => (
                <div
                  key={b.name}
                  id={optionId(i)}
                  data-index={i}
                  role="option"
                  aria-selected={i === activeIndex}
                  aria-disabled={busy ? true : undefined}
                  className={cn(
                    "group flex items-center gap-2 pl-1.5 pr-1 h-control-md rounded-md text-xs transition-colors duration-fast",
                    busy ? "cursor-default" : "cursor-pointer",
                    i === activeIndex && !busy && "bg-element-hover",
                    b.isCurrent
                      ? "text-foreground"
                      : busy
                        ? "text-muted-foreground"
                        : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
                  )}
                  onMouseMove={() => {
                    if (i !== activeIndex) setActive(i);
                  }}
                  onClick={() => pick(b)}
                >
                  <Check
                    size={12}
                    className={cn("shrink-0", b.isCurrent ? "text-primary" : "opacity-0")}
                  />
                  <span className="truncate flex-1 font-mono" title={b.name}>
                    {b.name}
                  </span>
                  {b.isRemote && (
                    <Badge variant="outline" size="sm">
                      remote
                    </Badge>
                  )}
                  {(b.ahead > 0 || b.behind > 0) && (
                    <span className="shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
                      {b.ahead > 0 && `↑${b.ahead}`} {b.behind > 0 && `↓${b.behind}`}
                    </span>
                  )}
                  {!b.isCurrent && !b.isRemote && (
                    <HintGroup>
                      <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        {!busy && !detached && (
                          <HintItem label={`Merge ${b.name} into ${branch}`}>
                            <IconButton
                              size="xs"
                              icon={GitMerge}
                              label={`Merge ${b.name} into ${branch}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                void run(() => actions.mergeBranch(b.name));
                              }}
                            />
                          </HintItem>
                        )}
                        <HintItem label={`Delete ${b.name}`}>
                          <IconButton
                            size="xs"
                            variant="ghost-destructive"
                            icon={Trash2}
                            label={`Delete ${b.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void run(() => actions.deleteBranch(b.name));
                            }}
                          />
                        </HintItem>
                      </div>
                    </HintGroup>
                  )}
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-2xs text-muted-foreground text-center">
                  No branches
                </div>
              )}
            </div>

            <div className="border-t border-border-subtle p-1 shrink-0">
              {creating ? (
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                  placeholder="new-branch-name"
                  className="font-mono"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newName.trim()) {
                      void run(() => actions.createBranch(newName.trim()));
                      setOpen(false);
                    } else if (e.key === "Escape") {
                      setCreating(false);
                      setNewName("");
                    }
                  }}
                />
              ) : (
                <Button
                  variant="ghost"
                  onClick={() => setCreating(true)}
                  className="w-full justify-start"
                >
                  <Plus size={12} />
                  New branch from {base}
                </Button>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
