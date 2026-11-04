import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import { Button, Icon, Popover, PopoverContent, PopoverTrigger, Spinner } from "@tryatlas/design";
import { cn } from "@/lib/utils";

export interface BranchPickerViewProps {
  /** The checked-out branch, or `null` when HEAD is detached. */
  branch: string | null;
  disabled: boolean;
  /** Origin's branches; asked once, the first time the picker opens. */
  loadBranches: () => Promise<string[]>;
  onSwitch: (branch: string) => void;
}

/** A clone's branch: a popover with a filter box over origin's branches. */
export function BranchPickerView({
  branch,
  disabled,
  loadBranches,
  onSwitch,
}: BranchPickerViewProps) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // Through a ref: a container re-render hands a fresh closure, which must
  // not cancel and re-ask an in-flight load.
  const loadRef = useRef(loadBranches);
  useEffect(() => {
    loadRef.current = loadBranches;
  }, [loadBranches]);

  useEffect(() => {
    if (!open || branches) return;
    let cancelled = false;
    setError(null);
    loadRef
      .current()
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, branches]);

  const shown = useMemo(() => {
    if (!branches) return [];
    const q = filter.trim().toLowerCase();
    const list = q ? branches.filter((b) => b.toLowerCase().includes(q)) : branches;
    // The checked-out branch first, so it is never buried under a long list.
    return branch && list.includes(branch) ? [branch, ...list.filter((b) => b !== branch)] : list;
  }, [branches, filter, branch]);

  const filterRef = useRef<HTMLInputElement>(null);

  /** Close, and switch only when the branch is not the checked-out one. */
  const pick = (b: string) => {
    setOpen(false);
    setFilter("");
    if (b !== branch) onSwitch(b);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setFilter("");
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled}
            className="min-w-0"
            title="Switch to another remote branch"
          >
            <Icon icon={GitBranch} size="xs" />
            <span className="max-w-36 truncate">{branch ?? "detached"}</span>
            <Icon icon={ChevronDown} size="xs" />
          </Button>
        }
      />
      <PopoverContent
        align="start"
        className="w-64 gap-0 p-0"
        // Land in the filter box, not on the first row.
        initialFocus={filterRef}
      >
        {/* A bare filter row, as in source control's branch switcher: no
            field border, so not an `InputGroup`. */}
        <div className="flex h-control-lg items-center gap-1.5 border-b border-border-subtle px-2.5">
          <Icon icon={Search} size="sm" className="text-muted-foreground" />
          <input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              // Enter picks the first row, exactly as clicking it would.
              if (e.key === "Enter" && shown[0]) pick(shown[0]);
            }}
            placeholder="Filter branches"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          {branches ? (
            <span className="text-3xs text-muted-foreground tabular-nums">{shown.length}</span>
          ) : null}
        </div>
        <div className="max-h-64 overflow-y-auto p-1 hide-scrollbar">
          {error ? (
            <div className="px-2 py-1.5 text-2xs text-error">{error}</div>
          ) : !branches ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted-foreground">
              <Spinner size="xs" label="" /> Fetching branches
            </div>
          ) : shown.length === 0 ? (
            <div className="px-2 py-1.5 text-2xs text-muted-foreground">
              {filter ? "No branch matches" : "No branches"}
            </div>
          ) : (
            shown.map((b) => {
              const current = b === branch;
              return (
                <button
                  key={b}
                  type="button"
                  role="option"
                  aria-selected={current}
                  onClick={() => pick(b)}
                  className={cn(
                    "flex h-control-md w-full cursor-pointer items-center gap-2 rounded-md pr-1.5 pl-2 text-left text-xs outline-none transition-colors duration-fast",
                    current
                      ? "text-foreground"
                      : "text-secondary-foreground hover:bg-element-hover hover:text-foreground focus-visible:bg-element-hover",
                  )}
                >
                  <span className="flex-1 truncate font-mono">{b}</span>
                  {current ? <Icon icon={Check} size="sm" className="text-primary" /> : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
