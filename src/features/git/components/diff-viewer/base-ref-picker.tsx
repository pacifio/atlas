import { useEffect, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "@/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Switch } from "@/ui/switch";
import { Hint } from "@/ui/tooltip";
import { cn } from "@/lib/utils";
import type { BranchInfo } from "../../stores/git-store";
import {
  buildBaseRefChoices,
  filterBaseRefChoices,
  refOfChoice,
  toggledRef,
  type BaseRefChoice,
} from "../../lib/base-ref-choices";

/**
 * "Compare against": the branch range's base. A searchable list: Automatic
 * (the remote default, as the backend picks it), then every branch, local
 * ones paired with their remote-tracking twin. A paired row's switch takes
 * the remote's copy instead of the local branch; a remote branch with no
 * local one wears a check under Remote. Typing filters, the arrow keys move
 * the highlight, Enter picks it and Escape closes.
 */

type Row = { kind: "automatic" } | { kind: "choice"; choice: BaseRefChoice };

const AUTOMATIC_ROW: Row = { kind: "automatic" };

/** Rows rendered at once. A repository with thousands of remote branches is
 *  searched, not scrolled. */
export const MAX_REF_ROWS = 200;

export function BaseRefPicker({
  current,
  chosen,
  branches,
  head,
  onPick,
}: {
  /** What the backend compared against. */
  current: string | null;
  /** What the reader picked; `null` is automatic. */
  chosen: string | null;
  /** Local and remote branches, as `git_branches_full` lists them. */
  branches: readonly BranchInfo[];
  /** The branch being compared, left out of the list. */
  head: string | null;
  onPick: (ref: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();

  const choices = useMemo(() => buildBaseRefChoices(branches, head), [branches, head]);
  const rows = useMemo<Row[]>(() => {
    const matching = filterBaseRefChoices(choices, query)
      .slice(0, MAX_REF_ROWS)
      .map((choice): Row => ({ kind: "choice", choice }));
    // As in a search anywhere else, "Automatic" is not a match for text.
    return query.trim() ? matching : [AUTOMATIC_ROW, ...matching];
  }, [choices, query]);
  const highlighted = Math.min(active, rows.length - 1);

  const refOf = (row: Row) => (row.kind === "automatic" ? null : refOfChoice(row.choice, chosen));
  const pick = (row: Row) => {
    onPick(refOf(row));
    setOpen(false);
  };
  const rowId = (index: number) => `${listId}-row-${index}`;
  const move = (by: number) => {
    const count = rows.length;
    if (count === 0) return;
    setActive((a) => (Math.min(a, count - 1) + by + count) % count);
  };
  // The highlight stays in view as the keys walk it past the list's edge.
  useEffect(() => {
    if (open) document.getElementById(rowId(highlighted))?.scrollIntoView?.({ block: "nearest" });
    // `rowId` is derived from `listId`, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, highlighted]);
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      const row = rows[highlighted];
      if (!row) return;
      event.preventDefault();
      pick(row);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
        setActive(0);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            // The ref is the point of the control, so the head branch beside
            // it is what gives way in a narrow panel, not this.
            className="shrink-0"
            aria-label={`Change comparison target. Currently ${current ?? "the base branch"}`}
          >
            <span className="max-w-40 min-w-0 truncate">{current ?? "base"}</span>
            <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <PopoverContent align="start" sideOffset={4} className="flex w-88 flex-col p-0">
        <div className="flex h-control-lg shrink-0 items-center gap-1.5 border-b border-border px-2.5">
          <Search aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={rows[highlighted] ? rowId(highlighted) : undefined}
            aria-label="Search refs"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search refs…"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div
          aria-hidden
          className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)_2.75rem] items-center gap-2 border-b border-border-subtle px-2.5 pt-2 pb-1.5 text-3xs font-medium tracking-wide text-muted-foreground uppercase"
        >
          <span />
          <span>Branch</span>
          <span className="text-right">Remote</span>
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Refs"
          className="max-h-64 min-h-0 overflow-y-auto overscroll-contain p-1"
        >
          {rows.length === 0 && (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              No matching refs.
            </div>
          )}
          {rows.map((row, index) => {
            const ref = refOf(row);
            const selected = ref === chosen;
            const choice = row.kind === "choice" ? row.choice : null;
            const label = choice ? choice.label : "Automatic";
            return (
              <div
                key={choice ? choice.id : "automatic"}
                id={rowId(index)}
                role="option"
                aria-selected={index === highlighted}
                aria-checked={selected}
                data-active={index === highlighted || undefined}
                onMouseMove={() => index !== highlighted && setActive(index)}
                onClick={() => pick(row)}
                className={cn(
                  "grid min-h-7 cursor-pointer grid-cols-[1rem_minmax(0,1fr)_2.75rem] items-center gap-2 rounded-md px-1.5 text-xs text-foreground select-none",
                  index === highlighted && "bg-element-selected",
                )}
              >
                <span className="flex items-center text-muted-foreground">
                  {selected && <Check aria-hidden className="size-3" />}
                </span>
                <span className="min-w-0 truncate">{label}</span>
                <span className="flex justify-end">
                  {choice?.local && choice.remote ? (
                    <span
                      className="flex"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <Switch
                        size="sm"
                        aria-label={`Use remote version of ${choice.label}`}
                        checked={ref === choice.remote}
                        onCheckedChange={(useRemote) => {
                          const next = toggledRef(choice, useRemote);
                          if (next) onPick(next);
                        }}
                      />
                    </span>
                  ) : choice?.remote ? (
                    <Hint label="Remote only">
                      <span className="flex text-muted-foreground">
                        <Check role="img" aria-label="Remote only" className="size-3" />
                      </span>
                    </Hint>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
