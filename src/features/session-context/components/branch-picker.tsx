// The branch row: the current branch, and a picker to switch it.
//
// A popover, not a menu: the picker opens on a search field, and a menu takes
// every typed key for its own typeahead. The field filters the local
// branches; ↑/↓ move through the matches and Enter takes one. A name that
// matches no branch exactly is offered as "Create branch <name>", which
// creates it from HEAD and switches to it. Source Control closes the list,
// for what the picker does not do (rename, delete, remote branches).

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { Popover } from "@base-ui/react/popover";
import { Check, ChevronDown, GitBranch, GitBranchPlus, GitCommitHorizontal } from "lucide-react";

import { useGitStore } from "@/features/git/stores/git-store";
import { cn } from "@/lib/utils";
import { Input } from "@/ui/input";

import { checkoutBranch, createAndCheckoutBranch, revealSourceControl } from "../lib/git-actions";
import { MenuButton, RowIcon, RowLabel } from "./context-rows";

/** One option in the list: switch to a branch, or create one. */
type BranchOption =
  | { kind: "branch"; name: string; current: boolean }
  | { kind: "create"; name: string };

/** The options for `query`, current branch first. Pure, for the test. */
export function branchOptions(
  branches: readonly { name: string; isCurrent: boolean }[],
  query: string,
): BranchOption[] {
  const q = query.trim();
  const needle = q.toLowerCase();
  const matches = branches
    .filter((b) => !needle || b.name.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.name.localeCompare(b.name))
    .map((b): BranchOption => ({ kind: "branch", name: b.name, current: b.isCurrent }));
  const exact = branches.some((b) => b.name === q);
  return q && !exact ? [...matches, { kind: "create", name: q }] : matches;
}

/** What a typed name becomes as a branch. A ref name has no whitespace, so a
 *  run of it reads as a dash. */
function toBranchName(raw: string): string {
  return raw.replace(/\s+/g, "-");
}

export function BranchPicker() {
  const branch = useGitStore.use.branch();
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <MenuButton kind="row" aria-label={`Branch ${branch || "none"}. Switch branch`}>
            <RowIcon icon={GitBranch} />
            <RowLabel>{branch || "No branch"}</RowLabel>
            <span className="flex h-4 w-8 shrink-0 items-center justify-center border-s border-border text-muted-foreground">
              <ChevronDown size={14} aria-hidden />
            </span>
          </MenuButton>
        }
      />
      <Popover.Portal>
        <Popover.Positioner className="z-popover" side="bottom" align="end" sideOffset={4}>
          <Popover.Popup
            aria-label="Switch branch"
            className="flex max-h-(--available-height) w-64 origin-[var(--transform-origin)] flex-col rounded-lg border border-border bg-popover text-foreground shadow-md outline-none data-closed:animate-scale-out data-open:animate-scale-in"
          >
            {/* Mounted per open, so each open starts on an empty search. */}
            {open && <BranchList onDone={() => setOpen(false)} />}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function BranchList({ onDone }: { onDone: () => void }) {
  const id = useId();
  const branches = useGitStore.use.branchesFull();
  const busy = useGitStore((s) => !!s.activeOp?.running);
  const local = useMemo(() => branches.filter((b) => !b.isRemote), [branches]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const options = useMemo(() => branchOptions(local, query), [local, query]);
  const index = Math.min(active, Math.max(options.length - 1, 0));

  const choose = (option: BranchOption | undefined) => {
    if (!option || busy) return;
    if (option.kind === "branch") {
      onDone();
      if (!option.current) void checkoutBranch(option.name);
      return;
    }
    onDone();
    void createAndCheckoutBranch(option.name);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(options[index]);
    }
  };

  const optionId = (i: number) => `${id}-option-${i}`;

  return (
    <>
      <div className="border-b border-border p-1.5">
        <Input
          size="sm"
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={options.length > 0 ? optionId(index) : undefined}
          aria-label="Search or create a branch"
          placeholder="Search or create a branch"
          value={query}
          onChange={(event) => {
            setQuery(toBranchName(event.target.value));
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul
        id={`${id}-list`}
        role="listbox"
        aria-label="Branches"
        className="m-0 max-h-60 min-h-0 list-none overflow-y-auto overscroll-contain p-1"
      >
        {options.length === 0 && (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">No local branches</li>
        )}
        {options.map((option, i) => (
          <li
            key={`${option.kind}:${option.name}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === index}
            aria-disabled={busy || undefined}
            onMouseEnter={() => setActive(i)}
            // Keeps focus in the field, so the keys keep working after a hover.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(option)}
            className={cn(
              "flex h-7 cursor-pointer items-center gap-2 rounded px-2 text-xs text-secondary-foreground",
              i === index && "bg-element-hover text-foreground",
              busy && "cursor-default opacity-60",
            )}
          >
            {option.kind === "create" ? (
              <>
                <GitBranchPlus size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  Create branch <span className="font-mono text-foreground">{option.name}</span>
                </span>
              </>
            ) : (
              <>
                {option.current ? (
                  <Check size={14} className="shrink-0 text-foreground" aria-hidden />
                ) : (
                  <GitBranch size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="border-t border-border p-1">
        <button
          type="button"
          onClick={() => {
            onDone();
            revealSourceControl();
          }}
          className="flex h-7 w-full cursor-pointer items-center gap-2 rounded px-2 text-left text-xs text-secondary-foreground outline-none hover:bg-element-hover hover:text-foreground focus-visible:bg-element-hover"
        >
          <GitCommitHorizontal size={14} className="shrink-0 text-muted-foreground" aria-hidden />
          Open Source Control
        </button>
      </div>
    </>
  );
}
