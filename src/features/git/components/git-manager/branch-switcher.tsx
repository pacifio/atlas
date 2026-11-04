import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { GitBranch, Check, Plus, Search, Trash2, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStore } from "../../stores/git-store";
import { handleGitError } from "../../lib/git-errors";
import { Badge, Button, IconButton, Input, HintGroup, HintItem } from "@tryatlas/design";

/** Branch switcher popover: filter, checkout, create, delete, merge-into-current. */
export function BranchSwitcher() {
  const branch = useGitStore.use.branch();
  const branchesFull = useGitStore.use.branchesFull();
  const actions = useGitStore.use.actions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return branchesFull.filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [branchesFull, query]);

  const run = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      handleGitError(e);
    }
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setQuery("");
          setCreating(false);
          setNewName("");
        }
      }}
    >
      <Popover.Trigger
        render={
          <Button variant="ghost" size="sm" className="min-w-0 shrink" title="Switch branch">
            <GitBranch size={12} />
            <span className="truncate">{branch || "—"}</span>
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
                placeholder="Filter branches…"
                autoFocus
                className="flex-1 bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground min-w-0"
              />
            </div>

            <div className="max-h-[280px] overflow-y-auto hide-scrollbar p-1">
              {filtered.map((b) => (
                <div
                  key={b.name}
                  className={cn(
                    "group flex items-center gap-2 pl-1.5 pr-1 h-control-md rounded-md text-xs cursor-pointer transition-colors duration-fast",
                    b.isCurrent
                      ? "text-foreground"
                      : "text-secondary-foreground hover:bg-element-hover hover:text-foreground",
                  )}
                  onClick={() => {
                    if (b.isCurrent) return;
                    // Remote-tracking refs (origin/foo) must be checked out by their
                    // short name so git creates a local tracking branch instead of
                    // landing in detached HEAD.
                    const target = b.isRemote ? b.name.slice(b.name.indexOf("/") + 1) : b.name;
                    void run(() => actions.checkout(target));
                    setOpen(false);
                  }}
                >
                  <Check
                    size={12}
                    className={cn("shrink-0", b.isCurrent ? "text-primary" : "opacity-0")}
                  />
                  <span className="truncate flex-1 font-mono">{b.name}</span>
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
                  New branch from {branch}
                </Button>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
