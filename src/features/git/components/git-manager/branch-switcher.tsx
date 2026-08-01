import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import { GitBranch, Check, Plus, Search, Trash2, GitMerge } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGitStore } from "../../stores/git-store";

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
      toast.error(String(e));
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
      <Popover.Trigger asChild>
        <button
          className="flex items-center gap-1.5 h-6 px-2 rounded text-[11px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer min-w-0"
          title="Switch branch"
        >
          <GitBranch size={12} className="shrink-0" />
          <span className="truncate max-w-[120px]">{branch || "—"}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className="w-[260px] rounded-lg border border-border-default bg-[var(--bg-elevated)] shadow-[var(--shadow-overlay)] flex flex-col"
          style={{ zIndex: 99999 }}
        >
          <div className="flex items-center gap-1.5 px-2 h-[30px] border-b border-border-default shrink-0">
            <Search size={11} className="text-text-tertiary shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter branches…"
              autoFocus
              className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary min-w-0"
            />
          </div>

          <div className="max-h-[280px] overflow-y-auto hide-scrollbar py-1">
            {filtered.map((b) => (
              <div
                key={b.name}
                className={cn(
                  "group flex items-center gap-2 px-2 h-[28px] text-[11px] cursor-pointer",
                  b.isCurrent
                    ? "text-text-primary"
                    : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
                )}
                onClick={() => {
                  if (b.isCurrent) return;
                  // Remote-tracking refs (origin/foo) must be checked out by their
                  // short name so git creates a local tracking branch instead of
                  // landing in detached HEAD.
                  const target = b.isRemote
                    ? b.name.slice(b.name.indexOf("/") + 1)
                    : b.name;
                  void run(() => actions.checkout(target));
                  setOpen(false);
                }}
              >
                <Check
                  size={12}
                  className={cn(
                    "shrink-0",
                    b.isCurrent ? "text-accent" : "opacity-0",
                  )}
                />
                <span className="truncate flex-1 font-mono">{b.name}</span>
                {b.isRemote && (
                  <span className="shrink-0 text-[8px] font-mono uppercase tracking-wide text-text-tertiary border border-border-default rounded px-1">
                    remote
                  </span>
                )}
                {(b.ahead > 0 || b.behind > 0) && (
                  <span className="shrink-0 text-[9px] font-mono text-text-tertiary">
                    {b.ahead > 0 && `↑${b.ahead}`}{" "}
                    {b.behind > 0 && `↓${b.behind}`}
                  </span>
                )}
                {!b.isCurrent && !b.isRemote && (
                  <div className="flex items-center opacity-0 group-hover:opacity-100">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(() => actions.mergeBranch(b.name));
                      }}
                      className="p-0.5 rounded text-text-tertiary hover:text-text-primary"
                      title={`Merge ${b.name} into ${branch}`}
                    >
                      <GitMerge size={11} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void run(() => actions.deleteBranch(b.name));
                      }}
                      className="p-0.5 rounded text-text-tertiary hover:text-[var(--status-error)]"
                      title={`Delete ${b.name}`}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[10px] text-text-tertiary text-center">
                No branches
              </div>
            )}
          </div>

          <div className="border-t border-border-default p-1.5 shrink-0">
            {creating ? (
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
                placeholder="new-branch-name"
                className="w-full h-7 rounded border border-border-default bg-bg-input px-2 text-[11px] font-mono text-text-primary outline-none focus:border-border-focus"
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
              <button
                onClick={() => setCreating(true)}
                className="w-full flex items-center gap-1.5 h-7 px-2 rounded text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors"
              >
                <Plus size={12} />
                New branch from {branch}
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
