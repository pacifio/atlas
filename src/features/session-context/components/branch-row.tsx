// The branch row: the checkout's branch, and a picker to switch it.
//
// A popover, not a menu: the picker opens on a search field, and a menu takes
// every typed key for its own typeahead. The field filters the branches,
// local first, then the remote ones that have no local copy; ↑/↓ move
// through the matches and Enter takes one. Each carries a badge: current,
// default, remote. A name that matches no branch exactly is offered as
// "Create branch <name>", made at HEAD and switched to. Right-click copies
// the branch name.
//
// Everything acts on the session's checkout by path (`session-git-api.ts`),
// so the row is right for a background project and a worktree session alike.

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Copy, GitBranch, GitBranchPlus } from "lucide-react";

import type { BranchInfo } from "@/features/git/stores/git-store";
import { gitErrorText } from "@/features/notifications/lib/outcome-notifier";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { Input } from "@/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";

import { gitCheckout, gitCreateBranch } from "../lib/session-git-api";
import { refreshSessionGit, type SessionGit } from "../lib/use-session-git";
import { DetailsSelect, RowIcon, RowLabel } from "./details-rows";

type Badge = "current" | "default" | "remote";

/** One option in the list: switch to a branch, or create one. */
export type BranchOption =
  | { kind: "branch"; name: string; checkout: string; badge: Badge | null }
  | { kind: "create"; name: string };

/** `origin/feature` → `feature`. */
function localName(remote: string): string {
  const slash = remote.indexOf("/");
  return slash === -1 ? remote : remote.slice(slash + 1);
}

/**
 * The options for `query`: the current branch, then local branches, then
 * remote ones with no local copy (switching to one makes the local copy).
 * Pure, for the test.
 */
export function branchOptions(
  branches: readonly Pick<BranchInfo, "name" | "isCurrent" | "isRemote">[],
  defaultBranch: string | null,
  query: string,
): BranchOption[] {
  const q = query.trim();
  const needle = q.toLowerCase();
  const local = new Set(branches.filter((b) => !b.isRemote).map((b) => b.name));
  const rank = (b: { isCurrent: boolean; isRemote: boolean }) =>
    b.isCurrent ? 0 : b.isRemote ? 2 : 1;
  const options = branches
    // `origin/HEAD` is a pointer, not a branch.
    .filter((b) => !(b.isRemote && (b.name.endsWith("/HEAD") || local.has(localName(b.name)))))
    .filter((b) => !needle || b.name.toLowerCase().includes(needle))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((b): BranchOption => ({
      kind: "branch",
      name: b.name,
      checkout: b.isRemote ? localName(b.name) : b.name,
      badge: b.isCurrent
        ? "current"
        : !b.isRemote && b.name === defaultBranch
          ? "default"
          : b.isRemote
            ? "remote"
            : null,
    }));
  const exact = branches.some((b) => b.name === q || (b.isRemote && localName(b.name) === q));
  return q && !exact ? [...options, { kind: "create", name: q }] : options;
}

/** What a typed name becomes as a branch: a ref has no whitespace. */
function toBranchName(raw: string): string {
  return raw.replace(/\s+/g, "-");
}

export function BranchRow({ path, git }: { path: string; git: SessionGit }) {
  const [open, setOpen] = useState(false);
  const { branch, detached } = git.snapshot;
  const label = detached ? `Detached at ${branch || "HEAD"}` : branch || "No branch";
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="contents" />}>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={<DetailsSelect aria-label={`Branch ${label}. Switch branch`} title={label} />}
          >
            <RowIcon icon={GitBranch} />
            <RowLabel>{label}</RowLabel>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            aria-label="Switch branch"
            className="flex w-(--anchor-width) flex-col p-0"
          >
            {/* Mounted per open, so each open starts on an empty search. */}
            {open && <BranchList path={path} git={git} onDone={() => setOpen(false)} />}
          </PopoverContent>
        </Popover>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={detached || !branch}
          onClick={() =>
            void navigator.clipboard
              .writeText(branch)
              .then(() => toast.success("Branch name copied"))
          }
        >
          <Copy />
          Copy branch name
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function BranchList({ path, git, onDone }: { path: string; git: SessionGit; onDone: () => void }) {
  const id = useId();
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const options = useMemo(
    () => branchOptions(git.snapshot.branches, git.compare?.defaultBranch ?? null, query),
    [git.snapshot.branches, git.compare?.defaultBranch, query],
  );
  const index = Math.min(active, Math.max(options.length - 1, 0));

  const choose = (option: BranchOption | undefined) => {
    if (!option) return;
    onDone();
    if (option.kind === "branch" && option.badge === "current") return;
    const run =
      option.kind === "branch"
        ? gitCheckout(path, option.checkout)
        : gitCreateBranch(path, option.name);
    void run
      .catch((e) =>
        toast.error(
          option.kind === "branch" ? "Could not switch branch" : "Could not create the branch",
          {
            description: gitErrorText(e),
          },
        ),
      )
      .finally(() => void refreshSessionGit(client, path));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index + step + options.length) % options.length);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
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
        className="m-0 max-h-56 min-h-0 list-none overflow-y-auto overscroll-contain p-1"
      >
        {options.length === 0 && (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">No branches found</li>
        )}
        {options.map((option, i) => (
          <li
            key={`${option.kind}:${option.name}`}
            id={optionId(i)}
            role="option"
            aria-selected={i === index}
            onMouseEnter={() => setActive(i)}
            // Keeps focus in the field, so the keys keep working after a hover.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(option)}
            className={cn(
              "flex h-7 cursor-pointer items-center gap-2 rounded px-2 text-xs text-secondary-foreground",
              i === index && "bg-element-hover text-foreground",
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
                <GitBranch size={14} className="shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{option.name}</span>
                {option.badge && (
                  <span className="shrink-0 text-2xs text-muted-foreground">{option.badge}</span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
